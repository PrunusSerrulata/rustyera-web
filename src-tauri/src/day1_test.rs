use std::path::PathBuf;
use std::time::{Duration, Instant};

use era_debug_protocol::{
    AuthorizedDebugRequest, DEBUG_PROTOCOL_VERSION, DebugCommand, DebugGrant, DebugHello,
    DebugMessage, DebugResponse, DebugScope, DebugStop, GrantToken,
};
use era_protocol::{ProtocolBytes, decode_canonical, encode_canonical};
use era_runtime::RuntimeDriveBudget;
use era_runtime_protocol::{
    EffectAcknowledgement, EffectBatch, EffectOutcome, EffectOutcomeStatus, FrontendInput,
    GetKeyStateResponse, ImageMetadataRequest, ImageMetadataResponse, InputIntent, InputWait,
    LocalDateTimeResponse, RandomSeedResponse, ReturnToTitleRequest, RuntimeMessage, ServiceError,
    ServiceKind, ServiceRequest, ServiceResponse, ServiceResult, StartMode, StartRequest,
    StorageRequest, WaitKind,
};
use era_web_bridge::{WebSession, WebSessionOptions};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::project::ProjectHost;
use crate::storage::StorageHost;

const ANSWERS: &[&str] = &[
    "0", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "0", "9999", "0", "2", "1999",
    "0", "100", "1",
];

#[test]
#[ignore = "requires the real eraTW project and performs a long cold compilation"]
#[allow(
    clippy::too_many_lines,
    reason = "the end-to-end driver keeps its event loop together"
)]
fn eratw_reaches_day_one_through_the_web_bridge() {
    let project =
        std::env::var_os("ERATW_PROJECT").map_or_else(|| PathBuf::from("../eraTW"), PathBuf::from);
    let use_cache = std::env::var_os("ERA_WEB_USE_CACHE").is_some();
    let stop_after_load = std::env::var_os("ERA_WEB_STOP_AFTER_LOAD").is_some();
    let stop_before_answer = std::env::var("ERA_WEB_STOP_BEFORE_ANSWER")
        .ok()
        .and_then(|value| value.parse::<usize>().ok());
    let trace_pumps = std::env::var_os("ERA_WEB_TRACE_PUMPS").is_some();
    let validate_debug = std::env::var_os("ERA_WEB_VALIDATE_DEBUG").is_some();
    let started = Instant::now();
    let mut session = WebSession::new(WebSessionOptions::default()).unwrap();
    session.pump(RuntimeDriveBudget::default()).unwrap();

    let scan_started = Instant::now();
    let mut host = ProjectHost::scan_quick(&project, 1).unwrap();
    let scan_elapsed = scan_started.elapsed();
    let identity = host.identity();
    let source_started = Instant::now();
    let cache_imported = use_cache
        && host.compiled_cache().unwrap().is_some_and(|cache| {
            session
                .load_project_with_compiled_cache(identity, &cache)
                .is_ok()
        });
    if !cache_imported {
        session.load_project(host.take_manifest().unwrap()).unwrap();
    }
    let source_elapsed = source_started.elapsed();
    let mut storage = StorageHost::new(host.root().to_owned());
    let mut answer_index = 0;
    let mut pump_index = 0_u64;
    let mut started_game = false;
    let mut returning_to_title = false;
    let mut returned_title_wait_seen = false;
    let mut display_text = String::new();
    let mut debug_requested = false;
    let mut debug_grant: Option<GrantToken> = None;
    let mut debug_variables_seen = false;
    let mut debug_fibers_seen = false;
    let mut debug_stack_seen = false;
    let deadline = Instant::now() + Duration::from_mins(30);

    while Instant::now() < deadline {
        let batch = session
            .pump(RuntimeDriveBudget {
                maximum_vm_instructions: 100_000,
                maximum_runtime_transitions: 1024,
            })
            .unwrap();
        pump_index = pump_index.saturating_add(1);
        if trace_pumps {
            let approximate_bytes = batch
                .events
                .iter()
                .map(|event| approximate_json_bytes(&event.message))
                .sum::<usize>();
            let mut event_types = std::collections::BTreeMap::<&str, usize>::new();
            for event in &batch.events {
                *event_types
                    .entry(event.message["type"].as_str().unwrap_or("unknown"))
                    .or_default() += 1;
            }
            eprintln!(
                "WEB_PUMP index={pump_index} elapsed_ms={} events={} approximate_json_bytes={approximate_bytes} types={event_types:?}",
                started.elapsed().as_millis(),
                batch.events.len(),
            );
        }
        for event in batch.events {
            let message_type = event.message["type"].as_str().unwrap_or_default();
            let value = event.message.get("value").cloned().unwrap_or(Value::Null);
            match message_type {
                "grant" => {
                    let grant: DebugGrant = from_value(value);
                    debug_grant = Some(grant.token);
                    session
                        .submit_debug(
                            &DebugMessage::Request(AuthorizedDebugRequest {
                                grant: grant.token,
                                command: DebugCommand::Pause,
                            }),
                            None,
                        )
                        .unwrap();
                }
                "stopped" => {
                    let stopped: DebugStop = from_value(value);
                    let grant = debug_grant.expect("debug stopped without a grant");
                    for command in [
                        DebugCommand::ListVariables {
                            stop: stopped.stop,
                            cursor: None,
                            limit: 256,
                        },
                        DebugCommand::ListFibers {
                            stop: stopped.stop,
                            cursor: None,
                            limit: 256,
                        },
                    ] {
                        session
                            .submit_debug(
                                &DebugMessage::Request(AuthorizedDebugRequest { grant, command }),
                                None,
                            )
                            .unwrap();
                    }
                }
                "response" => {
                    let response: DebugResponse = from_value(value);
                    match response {
                        DebugResponse::VariablePage(page) => {
                            assert!(
                                !page.variables.is_empty(),
                                "eraTW debugger returned no variables"
                            );
                            debug_variables_seen = true;
                        }
                        DebugResponse::FiberPage(page) => {
                            assert!(!page.fibers.is_empty(), "eraTW debugger returned no fibers");
                            debug_fibers_seen = true;
                            let fiber = page
                                .fibers
                                .iter()
                                .find(|fiber| fiber.frame_count > 0)
                                .expect("eraTW debugger returned no fiber with stack frames");
                            session
                                .submit_debug(
                                    &DebugMessage::Request(AuthorizedDebugRequest {
                                        grant: debug_grant.expect("fiber page without a grant"),
                                        command: DebugCommand::ReadCallStack {
                                            stop: page.stop,
                                            fiber_id: fiber.fiber_id,
                                        },
                                    }),
                                    None,
                                )
                                .unwrap();
                        }
                        DebugResponse::CallStack(stack) => {
                            assert!(
                                !stack.frames.is_empty(),
                                "eraTW debugger returned an empty stack"
                            );
                            debug_stack_seen = true;
                        }
                        DebugResponse::Accepted
                        | DebugResponse::VariableValue(_)
                        | DebugResponse::GameFieldPage(_)
                        | DebugResponse::GameFieldValue(_)
                        | DebugResponse::OperandStack(_)
                        | DebugResponse::Console(_)
                        | DebugResponse::Breakpoints(_)
                        | DebugResponse::VariablesWritten(_)
                        | DebugResponse::GameFieldsWritten(_)
                        | DebugResponse::ScriptOutput(_) => {}
                    }
                    if debug_variables_seen && debug_fibers_seen && debug_stack_seen {
                        eprintln!(
                            "WEB_DEBUG_MILESTONE variables=true fibers=true stack=true elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                        return;
                    }
                }
                "error" if validate_debug => panic!("debug protocol error: {value}"),
                "project_load_report" => {
                    if value["payload_required"].as_bool() == Some(true) {
                        session.load_project(host.take_manifest().unwrap()).unwrap();
                    } else if value["success"].as_bool() == Some(true) && !started_game {
                        eprintln!(
                            "WEB_PROJECT_LOADED cache={cache_imported} elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                        if stop_after_load {
                            return;
                        }
                        started_game = true;
                        session
                            .submit_runtime(
                                &RuntimeMessage::Start(StartRequest {
                                    mode: StartMode::NewGame { seed: None },
                                }),
                                None,
                            )
                            .unwrap();
                    } else if value["success"].as_bool() == Some(false) {
                        panic!("project load failed: {value}");
                    }
                }
                "service_request" => {
                    let request: ServiceRequest = from_value(value);
                    let response = service_response(&host, request);
                    session
                        .submit_runtime(
                            &RuntimeMessage::ServiceResponse(response),
                            event.correlation_id,
                        )
                        .unwrap();
                }
                "storage_request" => {
                    let request: StorageRequest = from_value(value);
                    session
                        .submit_runtime(
                            &RuntimeMessage::StorageResponse(storage.handle(request)),
                            event.correlation_id,
                        )
                        .unwrap();
                }
                "effect_batch" => {
                    let batch: EffectBatch = from_value(value);
                    let outcomes = batch
                        .effects
                        .into_iter()
                        .map(|effect| EffectOutcome {
                            effect_id: effect.effect_id,
                            status: EffectOutcomeStatus::Completed,
                            message: None,
                        })
                        .collect();
                    session
                        .submit_runtime(
                            &RuntimeMessage::EffectAcknowledgement(EffectAcknowledgement {
                                outcomes,
                            }),
                            None,
                        )
                        .unwrap();
                }
                "presentation_snapshot" | "presentation_delta" => {
                    collect_strings(&value, &mut display_text);
                    if display_text.len() > 4 * 1024 * 1024 {
                        let mut end = 2 * 1024 * 1024;
                        while !display_text.is_char_boundary(end) {
                            end += 1;
                        }
                        display_text.drain(..end);
                    }
                }
                "wait_changed" => {
                    if matches!(value["type"].as_str(), Some("opened" | "updated")) {
                        let wait: InputWait = from_value(value["value"].clone());
                        if returning_to_title {
                            returned_title_wait_seen = true;
                            continue;
                        }
                        if validate_debug && !debug_requested {
                            debug_requested = true;
                            session
                                .submit_debug(
                                    &DebugMessage::Hello(DebugHello {
                                        versions: era_protocol::VersionRange::exact(
                                            DEBUG_PROTOCOL_VERSION,
                                        ),
                                        requested_scopes: vec![
                                            DebugScope::VariablesRead,
                                            DebugScope::ExecutionRead,
                                            DebugScope::ExecutionControl,
                                        ],
                                    }),
                                    None,
                                )
                                .unwrap();
                            continue;
                        }
                        if stop_before_answer == Some(answer_index) {
                            eprintln!(
                                "WEB_WAIT_MILESTONE answer_index={answer_index} elapsed_ms={}",
                                started.elapsed().as_millis()
                            );
                            return;
                        }
                        let intent = if wait.kind == WaitKind::EnterKey {
                            InputIntent::Enter
                        } else if answer_index < ANSWERS.len() {
                            let answer = ANSWERS[answer_index];
                            answer_index += 1;
                            InputIntent::CommitText(answer.to_owned())
                        } else if wait.system_input
                            && ["SAVE", "LOAD", "UPDATE"]
                                .iter()
                                .all(|marker| display_text.contains(marker))
                        {
                            eprintln!(
                                "WEB_DAY1_MILESTONE answers={answer_index} cache={cache_imported} scan_ms={} source_and_submit_ms={} total_ms={}",
                                scan_elapsed.as_millis(),
                                source_elapsed.as_millis(),
                                started.elapsed().as_millis()
                            );
                            display_text.clear();
                            returning_to_title = true;
                            session
                                .submit_runtime(
                                    &RuntimeMessage::ReturnToTitle(ReturnToTitleRequest {}),
                                    None,
                                )
                                .unwrap();
                            continue;
                        } else {
                            panic!("unexpected wait after {answer_index} answers");
                        };
                        session
                            .submit_runtime(
                                &RuntimeMessage::Input(FrontendInput {
                                    wait_id: wait.wait_id,
                                    token: wait.submission_token,
                                    monotonic_time_ns: u64::try_from(started.elapsed().as_nanos())
                                        .unwrap_or(u64::MAX),
                                    intent,
                                    message_skip: false,
                                }),
                                None,
                            )
                            .unwrap();
                    }
                }
                "fault" => panic!("runtime fault: {value}"),
                "command_rejected" => panic!("runtime command rejected: {value}"),
                _ => {}
            }
        }
        if returned_title_wait_seen {
            assert!(
                display_text.contains("TW_title000"),
                "returned title presentation did not contain TW_title000; strings={} ",
                display_excerpt(&display_text)
            );
            eprintln!(
                "WEB_RETURN_TITLE_MILESTONE image=TW_title000 total_ms={}",
                started.elapsed().as_millis()
            );
            return;
        }
    }
    panic!("web bridge did not reach day one within 30 minutes");
}

fn approximate_json_bytes(value: &Value) -> usize {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => std::mem::size_of_val(value),
        Value::String(value) => value.len(),
        Value::Array(values) => values.iter().map(approximate_json_bytes).sum(),
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| key.len() + approximate_json_bytes(value))
            .sum(),
    }
}

fn service_response(host: &ProjectHost, request: ServiceRequest) -> ServiceResponse {
    let result = (|| -> Result<Vec<u8>, String> {
        match (request.kind, request.operation.as_str()) {
            (ServiceKind::Entropy, "random_seed") => encode(&RandomSeedResponse { seed: 1 }),
            (ServiceKind::Clock, "local_date_time") => encode(&LocalDateTimeResponse {
                year: 2026,
                month: 7,
                day: 28,
                hour: 12,
                minute: 0,
                second: 0,
                millisecond: 0,
                utc_offset_minutes: 480,
            }),
            (ServiceKind::InputState, "get_key_state") => encode(&GetKeyStateResponse {
                frontend_active: true,
                pressed: false,
                toggle_state: false,
            }),
            (ServiceKind::Image, "image_metadata") => {
                let query: ImageMetadataRequest = decode_canonical(request.payload.as_slice())
                    .map_err(|error| error.to_string())?;
                let bytes = host.read_resource_prefix(&query.resource_id, 1024 * 1024)?;
                encode(&decode_image_metadata(&query.resource_id, &bytes)?)
            }
            _ => Err(format!(
                "unsupported web day-one service {:?}/{}",
                request.kind, request.operation
            )),
        }
    })();
    ServiceResponse {
        request_id: request.request_id,
        result: match result {
            Ok(payload) => ServiceResult::Ready {
                payload: ProtocolBytes::new(payload),
            },
            Err(message) => ServiceResult::Error {
                error: ServiceError {
                    code: "web_test.unsupported_service".into(),
                    message,
                },
            },
        },
    }
}

fn encode<T: minicbor::Encode<()>>(value: &T) -> Result<Vec<u8>, String> {
    encode_canonical(value).map_err(|error| error.to_string())
}

fn decode_image_metadata(resource: &str, data: &[u8]) -> Result<ImageMetadataResponse, String> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") && data.len() >= 24 && &data[12..16] == b"IHDR" {
        return Ok(ImageMetadataResponse {
            width: u32::from_be_bytes(data[16..20].try_into().unwrap()),
            height: u32::from_be_bytes(data[20..24].try_into().unwrap()),
            format: "png".into(),
            animated: data.windows(4).any(|window| window == b"acTL"),
        });
    }
    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        let mut offset = 12;
        while offset + 8 <= data.len() {
            let kind = &data[offset..offset + 4];
            let length =
                u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let payload = offset + 8;
            if payload + length > data.len() {
                break;
            }
            if kind == b"VP8X" && length >= 10 {
                return Ok(ImageMetadataResponse {
                    width: 1 + uint24(&data[payload + 4..payload + 7]),
                    height: 1 + uint24(&data[payload + 7..payload + 10]),
                    format: "webp".into(),
                    animated: data[payload] & 2 != 0,
                });
            }
            if kind == b"VP8L" && length >= 5 && data[payload] == 0x2f {
                let bits = u32::from_le_bytes(data[payload + 1..payload + 5].try_into().unwrap());
                return Ok(ImageMetadataResponse {
                    width: 1 + (bits & 0x3fff),
                    height: 1 + ((bits >> 14) & 0x3fff),
                    format: "webp".into(),
                    animated: false,
                });
            }
            offset += 8 + length + (length & 1);
        }
    }
    Err(format!("cannot decode image metadata for {resource}"))
}

fn uint24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn collect_strings(value: &Value, output: &mut String) {
    match value {
        Value::String(text) => {
            output.push_str(text);
            output.push('\n');
        }
        Value::Array(items) => {
            for item in items {
                collect_strings(item, output);
            }
        }
        Value::Object(items) => {
            for item in items.values() {
                collect_strings(item, output);
            }
        }
        _ => {}
    }
}

fn display_excerpt(value: &str) -> String {
    value.chars().take(4_000).collect()
}

fn from_value<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}
