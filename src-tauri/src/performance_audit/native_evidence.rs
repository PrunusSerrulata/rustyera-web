//! Typed retention in the action; protocol CBOR encoding only at explicit export boundaries.
use era_runtime_protocol::RuntimeMessage;
use era_web_bridge::NativeCompletionEvidence;
use serde::Serialize;
use std::collections::VecDeque;

const MAXIMUM_BYTES: usize = 64 * 1024 * 1024;
const PAGE_BYTES: usize = 512 * 1024;
const HEX: &[u8] = b"0123456789abcdef";

#[derive(Default)]
pub(super) struct NativeEvidenceLedger {
    records: VecDeque<(u64, NativeCompletionEvidence)>,
    encoded: Option<(u64, Vec<u8>, usize)>,
    bytes: usize,
    next: u64,
    failure: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeEvidencePage {
    pub epoch: u64,
    pub next_sequence: u64,
    pub remaining_records: usize,
    /// Conservative cumulative retained allocation, not JSON or CBOR length.
    pub cumulative_bytes: usize,
    pub failure: Option<String>,
    pub records: Vec<NativeEvidenceChunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeEvidenceChunk {
    pub sequence: u64,
    pub offset: usize,
    pub total_bytes: usize,
    pub cbor_hex: String,
}

impl NativeEvidenceLedger {
    #[cfg(any(test, feature = "native-sql"))]
    pub(super) fn record(&mut self, completion: NativeCompletionEvidence) -> Result<(), String> {
        if let Some(failure) = &self.failure {
            return Err(failure.clone());
        }
        match retained_bytes(&completion) {
            Ok(cost) if cost <= MAXIMUM_BYTES.saturating_sub(self.bytes) => {
                self.bytes += cost;
                self.records.push_back((self.next, completion));
                self.next += 1;
                Ok(())
            }
            result => {
                let error = result.err().unwrap_or_else(|| {
                    "native evidence allocation limit exceeded; capture invalid".into()
                });
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }

    pub(super) fn page(&mut self, epoch: u64, limit: usize, drain: bool) -> NativeEvidencePage {
        let mut records = Vec::new();
        // Hex needs no JSON escaping. Reserve envelope and per-chunk metadata separately.
        let mut remaining = PAGE_BYTES - 4096;
        while drain && self.failure.is_none() && records.len() < limit && remaining > 512 {
            if self.encoded.is_none() {
                let Some((sequence, completion)) = self.records.pop_front() else {
                    break;
                };
                match encode(sequence, &completion) {
                    Ok(bytes) => self.encoded = Some((sequence, bytes, 0)),
                    Err(error) => {
                        self.failure = Some(error);
                        break;
                    }
                }
            }
            let (sequence, bytes, offset) = self.encoded.as_mut().expect("encoded record");
            let length = ((remaining - 256) / 2).min(bytes.len() - *offset);
            let mut cbor_hex = String::with_capacity(length * 2);
            for byte in &bytes[*offset..*offset + length] {
                cbor_hex.push(HEX[usize::from(byte >> 4)] as char);
                cbor_hex.push(HEX[usize::from(byte & 15)] as char);
            }
            records.push(NativeEvidenceChunk {
                sequence: *sequence,
                offset: *offset,
                total_bytes: bytes.len(),
                cbor_hex,
            });
            remaining -= length * 2 + 256;
            *offset += length;
            if *offset == bytes.len() {
                self.encoded = None;
            }
        }
        NativeEvidencePage {
            epoch,
            next_sequence: self.next,
            remaining_records: self.records.len() + usize::from(self.encoded.is_some()),
            cumulative_bytes: self.bytes,
            failure: self.failure.clone(),
            records,
        }
    }
}

// No serializer, byte scan, hash or encoded-length pass. Charge spare capacities,
// allocator metadata and queue growth conservatively. Only Listed metadata needs a loop.
#[cfg(any(test, feature = "native-sql"))]
fn retained_bytes(completion: &NativeCompletionEvidence) -> Result<usize, String> {
    use era_runtime_protocol::{
        ServiceResult, StorageOperation, StoragePrecondition, StorageResult,
    };
    fn text(value: &String) -> usize {
        value.capacity().saturating_add(64)
    }
    fn optional(value: Option<&String>) -> usize {
        value.map_or(0, text)
    }
    fn precondition(value: &StoragePrecondition) -> usize {
        match value {
            StoragePrecondition::Revision(value) => text(value),
            _ => 0,
        }
    }
    let mut bytes = 4 * std::mem::size_of::<(u64, NativeCompletionEvidence)>() + 256;
    let (request_id, response_id) = match (&completion.request.message, &completion.response) {
        (RuntimeMessage::ServiceRequest(request), RuntimeMessage::ServiceResponse(response)) => {
            bytes = bytes
                .saturating_add(text(&request.operation))
                .saturating_add(request.payload.0.capacity())
                .saturating_add(64);
            bytes = bytes.saturating_add(match &response.result {
                ServiceResult::Ready { payload } => payload.0.capacity().saturating_add(64),
                ServiceResult::Error { error } => {
                    text(&error.code).saturating_add(text(&error.message))
                }
            });
            (request.request_id, response.request_id)
        }
        (RuntimeMessage::StorageRequest(request), RuntimeMessage::StorageResponse(response)) => {
            bytes = bytes
                .saturating_add(text(&request.relative_path))
                .saturating_add(text(&request.idempotency_key));
            bytes = bytes.saturating_add(match &request.operation {
                StorageOperation::Write {
                    data,
                    precondition: condition,
                    ..
                } => data
                    .0
                    .capacity()
                    .saturating_add(64)
                    .saturating_add(precondition(condition)),
                StorageOperation::Delete {
                    precondition: condition,
                } => precondition(condition),
                StorageOperation::List { pattern, .. } => optional(pattern.as_ref()),
                StorageOperation::ReadRange { change_token, .. } => optional(change_token.as_ref()),
                StorageOperation::Read | StorageOperation::Stat => 0,
            });
            bytes = bytes.saturating_add(match &response.result {
                StorageResult::Read { data, revision } => data
                    .0
                    .capacity()
                    .saturating_add(64)
                    .saturating_add(optional(revision.as_ref())),
                StorageResult::ReadChunk {
                    data, change_token, ..
                } => data
                    .0
                    .capacity()
                    .saturating_add(64)
                    .saturating_add(text(change_token)),
                StorageResult::Written { revision } => optional(revision.as_ref()),
                StorageResult::Metadata(metadata) => optional(metadata.revision.as_ref()),
                StorageResult::Listed { entries } => entries.iter().fold(
                    entries
                        .capacity()
                        .saturating_mul(std::mem::size_of::<era_runtime_protocol::StorageEntry>())
                        .saturating_add(64),
                    |sum, entry| {
                        sum.saturating_add(text(&entry.relative_path))
                            .saturating_add(optional(entry.revision.as_ref()))
                            .saturating_add(optional(entry.change_token.as_ref()))
                    },
                ),
                StorageResult::Error { error } => text(&error.message),
                StorageResult::Deleted => 0,
            });
            (request.request_id, response.request_id)
        }
        _ => return Err("native evidence request/response type mismatch".into()),
    };
    if request_id != response_id || completion.request.epoch.is_none() {
        return Err("native evidence request/response identity mismatch".into());
    }
    Ok(bytes)
}

/// Wire v1: [1, ledgerSequence, outboundSequence, messageId, correlationId|null,
/// epoch, responseMessageId, kind (0=service,1=storage), typedRequest, typedResponse].
/// The final two items use the existing protocol's integer-keyed CBOR ABI.
fn encode(sequence: u64, completion: &NativeCompletionEvidence) -> Result<Vec<u8>, String> {
    struct Writer(Vec<u8>);
    impl minicbor::encode::Write for Writer {
        type Error = &'static str;
        fn write_all(&mut self, bytes: &[u8]) -> Result<(), Self::Error> {
            if bytes.len() > MAXIMUM_BYTES.saturating_sub(self.0.len()) {
                return Err("native evidence encoded byte limit exceeded");
            }
            self.0.extend_from_slice(bytes);
            Ok(())
        }
    }
    let mut encoder = minicbor::Encoder::new(Writer(Vec::new()));
    let result = (|| {
        encoder
            .array(10)?
            .u8(1)?
            .u64(sequence)?
            .u64(completion.request.sequence)?
            .u64(completion.request.message_id)?
            .encode(completion.request.correlation_id)?
            .encode(completion.request.epoch)?
            .u64(completion.response_message_id)?;
        match (&completion.request.message, &completion.response) {
            (
                RuntimeMessage::ServiceRequest(request),
                RuntimeMessage::ServiceResponse(response),
            ) => {
                encoder.u8(0)?.encode(request)?.encode(response)?;
            }
            (
                RuntimeMessage::StorageRequest(request),
                RuntimeMessage::StorageResponse(response),
            ) => {
                encoder.u8(1)?.encode(request)?.encode(response)?;
            }
            _ => {
                return Err(minicbor::encode::Error::message(
                    "native evidence variant mismatch",
                ));
            }
        }
        Ok(())
    })();
    result.map_err(|error: minicbor::encode::Error<&str>| error.to_string())?;
    Ok(encoder.into_writer().0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use era_runtime_protocol::{
        ProtocolBytes, StorageNamespace, StorageOperation, StoragePrecondition, StorageRequest,
        StorageResponse, StorageResult,
    };
    use era_web_bridge::NativeRequestEvidence;

    fn completion(id: u64, write: bool, data: Vec<u8>) -> NativeCompletionEvidence {
        let operation = if write {
            StorageOperation::Write {
                data: ProtocolBytes::new(data.clone()),
                atomic_replace: true,
                precondition: StoragePrecondition::Any,
            }
        } else {
            StorageOperation::Read
        };
        NativeCompletionEvidence {
            request: NativeRequestEvidence {
                sequence: u64::MAX,
                message_id: u64::MAX - 1,
                correlation_id: Some((1 << 53) + 1),
                epoch: Some(2),
                message: RuntimeMessage::StorageRequest(StorageRequest {
                    request_id: id,
                    namespace: StorageNamespace::Save,
                    relative_path: "\"\\\n".repeat(30_000),
                    operation,
                    idempotency_key: "key".into(),
                    deadline_ns: Some(u64::MAX),
                }),
            },
            response: RuntimeMessage::StorageResponse(StorageResponse {
                request_id: id,
                result: if write {
                    StorageResult::Written {
                        revision: Some("rev".into()),
                    }
                } else {
                    StorageResult::Read {
                        data: ProtocolBytes::new(data),
                        revision: Some("rev".into()),
                    }
                },
            }),
            response_message_id: u64::MAX,
        }
    }

    #[test]
    fn trailing_optional_fields_use_derived_protocol_encoding() {
        let request = StorageRequest {
            request_id: 7,
            namespace: StorageNamespace::Save,
            relative_path: "slot.sav".into(),
            operation: StorageOperation::ReadRange {
                offset: 0,
                maximum_bytes: 16,
                change_token: None,
            },
            idempotency_key: String::new(),
            deadline_ns: None,
        };
        for result in [
            StorageResult::Read {
                data: ProtocolBytes::new(vec![42]),
                revision: None,
            },
            StorageResult::Written { revision: None },
        ] {
            let evidence = NativeCompletionEvidence {
                request: NativeRequestEvidence {
                    sequence: 4,
                    message_id: 5,
                    correlation_id: Some(6),
                    epoch: Some(2),
                    message: RuntimeMessage::StorageRequest(request.clone()),
                },
                response: RuntimeMessage::StorageResponse(StorageResponse {
                    request_id: 7,
                    result,
                }),
                response_message_id: 8,
            };
            let encoded = encode(0, &evidence).unwrap();
            let hex: String = encoded
                .iter()
                .flat_map(|byte| {
                    [
                        char::from(HEX[usize::from(byte >> 4)]),
                        char::from(HEX[usize::from(byte & 15)]),
                    ]
                })
                .collect();
            println!("NATIVE_OPTIONAL_WIRE={hex}");
            let mut decoder = minicbor::Decoder::new(&encoded);
            decoder.array().unwrap();
            for _ in 0..8 {
                decoder.skip().unwrap();
            }
            assert_eq!(decoder.decode::<StorageRequest>().unwrap(), request);
            let RuntimeMessage::StorageResponse(expected) = evidence.response else {
                unreachable!()
            };
            assert_eq!(decoder.decode::<StorageResponse>().unwrap(), expected);
        }
    }

    #[test]
    fn large_binary_read_and_write_reassemble_across_bounded_pages_with_exact_ids() {
        for write in [false, true] {
            for id in [(1 << 53) + 1, u64::MAX] {
                let data: Vec<u8> = (0..700_000)
                    .map(|index| u8::try_from(index % 251).unwrap())
                    .collect();
                let evidence = completion(id, write, data);
                let expected = encode(0, &evidence).unwrap();
                assert!(expected.len() > PAGE_BYTES);
                let mut ledger = NativeEvidenceLedger::default();
                ledger.record(evidence).unwrap();
                assert!(ledger.encoded.is_none()); // No action-path encoding.
                let mut actual = Vec::new();
                let mut count = 0;
                loop {
                    let page = ledger.page(3, 512, true);
                    assert!(serde_json::to_vec(&page).unwrap().len() <= PAGE_BYTES);
                    assert!(page.failure.is_none());
                    for chunk in &page.records {
                        assert_eq!(chunk.sequence, 0);
                        assert_eq!(chunk.offset, actual.len());
                        for pair in chunk.cbor_hex.as_bytes().chunks_exact(2) {
                            actual.push(
                                u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap(),
                            );
                        }
                    }
                    count += 1;
                    if page.remaining_records == 0 {
                        break;
                    }
                }
                assert!(count > 1);
                assert_eq!(actual, expected);
                let mut decoder = minicbor::Decoder::new(&actual);
                assert_eq!(decoder.array().unwrap(), Some(10));
                assert_eq!(decoder.u8().unwrap(), 1);
                assert_eq!(decoder.u64().unwrap(), 0);
                assert_eq!(decoder.u64().unwrap(), u64::MAX);
                assert_eq!(decoder.u64().unwrap(), u64::MAX - 1);
                assert_eq!(decoder.u64().unwrap(), (1 << 53) + 1);
                assert_eq!(decoder.u64().unwrap(), 2);
                assert_eq!(decoder.u64().unwrap(), u64::MAX);
                assert_eq!(decoder.u8().unwrap(), 1);
                let request: StorageRequest = decoder.decode().unwrap();
                let response: StorageResponse = decoder.decode().unwrap();
                assert_eq!(request.request_id, id);
                assert_eq!(response.request_id, id);
                assert_eq!(decoder.position(), actual.len());
            }
        }
    }

    #[test]
    fn cumulative_allocation_cap_survives_drain_and_failure_is_sticky() {
        let mut ledger = NativeEvidenceLedger::default();
        ledger
            .record(completion(1, false, vec![1; 600_000]))
            .unwrap();
        let charged = ledger.bytes;
        while ledger.page(1, 512, true).remaining_records > 0 {}
        assert_eq!(ledger.bytes, charged);
        ledger.bytes = MAXIMUM_BYTES;
        assert!(ledger.record(completion(2, false, vec![2])).is_err());
        assert_eq!(ledger.bytes, MAXIMUM_BYTES);
        let failure = ledger.page(1, 0, false).failure;
        assert!(failure.is_some());
        assert!(ledger.record(completion(3, false, vec![])).is_err());
        assert_eq!(ledger.page(1, 512, true).failure, failure);
    }

    #[test]
    fn response_binary_is_moved_without_a_second_owned_copy() {
        let evidence = completion(1, false, vec![3; 600_000]);
        let RuntimeMessage::StorageResponse(StorageResponse {
            result: StorageResult::Read { data, .. },
            ..
        }) = &evidence.response
        else {
            panic!()
        };
        let pointer = data.0.as_ptr();
        let mut ledger = NativeEvidenceLedger::default();
        ledger.record(evidence).unwrap();
        let RuntimeMessage::StorageResponse(StorageResponse {
            result: StorageResult::Read { data, .. },
            ..
        }) = &ledger.records[0].1.response
        else {
            panic!()
        };
        assert_eq!(data.0.as_ptr(), pointer);
    }

    #[test]
    fn mismatched_completion_invalidates_capture_at_the_explicit_checkpoint() {
        let mut evidence = completion(1, false, vec![]);
        let RuntimeMessage::StorageResponse(response) = &mut evidence.response else {
            panic!()
        };
        response.request_id = 2;
        let mut ledger = NativeEvidenceLedger::default();
        assert!(ledger.record(evidence).is_err());
        assert!(ledger.page(1, 0, false).failure.is_some());
        assert!(ledger.records.is_empty());
    }
}
