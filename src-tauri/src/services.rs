use era_protocol::{ProtocolBytes, decode_canonical, encode_canonical};
use era_runtime_protocol::{
    DECODE_CANVAS_IMAGE_OPERATION, DecodeCanvasImageRequest, DecodeCanvasImageResponse,
    IMAGE_METADATA_OPERATION, ImageMetadataRequest, ImageMetadataResponse, ServiceKind,
    ServiceRequest, ServiceResponse, ServiceResult,
};

use crate::image_metadata;
use crate::project::ProjectHost;

pub(super) fn native_service(
    request: ServiceRequest,
    project: Option<&ProjectHost>,
) -> Option<ServiceResponse> {
    let payload = match (request.kind, request.operation.as_str()) {
        (ServiceKind::Canvas, DECODE_CANVAS_IMAGE_OPERATION) => {
            let decoded: DecodeCanvasImageRequest =
                decode_canonical(request.payload.as_slice()).ok()?;
            let metadata = image_metadata::decode(decoded.encoded.as_slice())?;
            encode_canonical(&DecodeCanvasImageResponse {
                width: metadata.width,
                height: metadata.height,
            })
            .ok()?
        }
        (ServiceKind::Image, IMAGE_METADATA_OPERATION) => {
            let decoded: ImageMetadataRequest =
                decode_canonical(request.payload.as_slice()).ok()?;
            let bytes = project?
                .read_resource_prefix(&decoded.resource_id, 1024 * 1024)
                .ok()?;
            let metadata = image_metadata::decode(&bytes)?;
            encode_canonical(&ImageMetadataResponse {
                width: metadata.width,
                height: metadata.height,
                format: metadata.format.into(),
                animated: metadata.animated,
            })
            .ok()?
        }
        _ => return None,
    };
    Some(ServiceResponse {
        request_id: request.request_id,
        result: ServiceResult::Ready {
            payload: ProtocolBytes::new(payload),
        },
    })
}
