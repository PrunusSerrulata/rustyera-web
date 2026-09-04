use super::WebSessionOptions;
use era_protocol::VersionRange;
use era_runtime_protocol::{
    AUDIO_OBSERVATION_OPERATION, ClientCapabilities, ClientHello, InputModality,
    RUNTIME_PROTOCOL_VERSION, RuntimeFeature, RuntimeLimits, SQL_OPERATION, ServiceCapability,
    ServiceKind, StorageCapabilities,
};

fn service_capabilities(audio_available: bool) -> Vec<ServiceCapability> {
    let v1 = VersionRange::exact(era_protocol::ProtocolVersion::new(1, 0));
    let mut services = [
        (ServiceKind::Entropy, "random_seed"),
        (ServiceKind::Clock, "local_date_time"),
        (ServiceKind::InputState, "get_key_state"),
        (
            ServiceKind::InputState,
            era_runtime_protocol::DEVICE_PUMP_OPERATION,
        ),
        (ServiceKind::InputState, "pointer_state"),
        (ServiceKind::Image, "image_metadata"),
        (ServiceKind::Image, "image_pixel"),
        (ServiceKind::Canvas, "decode_canvas_image"),
        (ServiceKind::Canvas, "sample_canvas_pixel"),
        (ServiceKind::PresentationQuery, "get_display_line"),
        (ServiceKind::PresentationQuery, "html_get_printed_str"),
        (ServiceKind::PresentationQuery, "serialize_physical_history"),
        (
            ServiceKind::PresentationQuery,
            era_runtime_protocol::GET_LINE_GEOMETRY_OPERATION,
        ),
        (ServiceKind::FontMetrics, "gget_text_size"),
        (ServiceKind::Sql, SQL_OPERATION),
    ]
    .into_iter()
    .map(|(kind, operation)| ServiceCapability {
        kind,
        operation: operation.into(),
        versions: v1,
    })
    .chain(
        ["html_string_len", "html_substring", "html_string_lines"]
            .into_iter()
            .map(|operation| ServiceCapability {
                kind: ServiceKind::PresentationQuery,
                operation: operation.into(),
                versions: VersionRange::exact(era_protocol::ProtocolVersion::new(2, 0)),
            }),
    )
    .collect::<Vec<_>>();
    if audio_available {
        services.push(ServiceCapability {
            kind: ServiceKind::Audio,
            operation: AUDIO_OBSERVATION_OPERATION.into(),
            versions: VersionRange::exact(era_protocol::ProtocolVersion::new(1, 0)),
        });
    }
    services
}

pub(super) fn client_hello(options: WebSessionOptions, limits: RuntimeLimits) -> ClientHello {
    let services = service_capabilities(options.audio_available);
    ClientHello {
        runtime_versions: VersionRange::exact(RUNTIME_PROTOCOL_VERSION),
        client_name: options.client_name,
        features: vec![
            RuntimeFeature::ProjectReload,
            RuntimeFeature::TraditionalSave,
            RuntimeFeature::VmSnapshot,
            RuntimeFeature::TimedInput,
            RuntimeFeature::RichText,
            RuntimeFeature::Html,
            RuntimeFeature::Graphics,
            RuntimeFeature::Audio,
            RuntimeFeature::MouseInput,
            RuntimeFeature::ExternalServices,
            RuntimeFeature::StateResynchronization,
            RuntimeFeature::Storage,
            RuntimeFeature::InputUndo,
            RuntimeFeature::ProjectAnalysis,
            RuntimeFeature::KeyMacros,
        ],
        requested_limits: limits,
        capabilities: ClientCapabilities {
            environment: [
                era_runtime_protocol::INPUT_TIMED_VIEWPORT_CAPABILITY,
                era_runtime_protocol::INPUT_DEVICE_LATCH_CAPABILITY,
                era_runtime_protocol::INPUT_DEVICE_PUMP_CAPABILITY,
            ]
            .into_iter()
            .map(|name| era_runtime_protocol::EnvironmentCapability {
                name: name.into(),
                versions: VersionRange::exact(era_runtime_protocol::INPUT_ENVIRONMENT_VERSION),
            })
            .collect(),
            input_modalities: vec![InputModality::Keyboard, InputModality::Mouse],
            rich_text: true,
            html: true,
            graphics: true,
            audio: options.audio_available,
            video: false,
            font_metrics: true,
            column_cells: true,
            separators: true,
            available_fonts: options.available_fonts,
            services,
            storage: StorageCapabilities {
                revisions: true,
                atomic_replace: true,
                missing_precondition: true,
                delete: true,
            },
        },
        preferred_locales: options.preferred_locales,
        configuration_profile: Some(options.configuration_profile),
    }
}
