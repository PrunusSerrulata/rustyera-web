use era_protocol::{ProtocolBytes, ProtocolVersion, decode_canonical, encode_canonical};
use era_runtime_protocol::{
    DECODE_CANVAS_IMAGE_OPERATION, DecodeCanvasImageRequest, DecodeCanvasImageResponse,
    ServiceKind, ServiceRequest, ServiceResult,
};
use std::collections::BTreeMap;

use super::*;
use crate::export::{
    cancel_compiled_cache_export_inner, write_atomic_file_chunk, write_compiled_cache_chunk_inner,
};
use crate::preferences::{Preferences, default_preferences};

#[test]
fn native_canvas_service_reads_png_dimensions() {
    let mut png = vec![0; 24];
    png[..8].copy_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    png[12..16].copy_from_slice(b"IHDR");
    png[16..20].copy_from_slice(&320_u32.to_be_bytes());
    png[20..24].copy_from_slice(&180_u32.to_be_bytes());
    let payload = encode_canonical(&DecodeCanvasImageRequest {
        encoded: ProtocolBytes::new(png),
    })
    .unwrap();
    let response = native_service(
        ServiceRequest {
            request_id: 7,
            kind: ServiceKind::Canvas,
            operation: DECODE_CANVAS_IMAGE_OPERATION.into(),
            operation_version: ProtocolVersion::new(1, 0),
            payload: ProtocolBytes::new(payload),
            deadline_ns: None,
        },
        None,
    )
    .unwrap();
    let ServiceResult::Ready { payload } = response.result else {
        panic!("expected native PNG response")
    };
    let decoded: DecodeCanvasImageResponse = decode_canonical(payload.as_slice()).unwrap();
    assert_eq!((decoded.width, decoded.height), (320, 180));
}

#[test]
fn compiled_cache_chunks_are_atomically_persisted() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("ERB")).unwrap();
    fs::write(directory.path().join("ERB/test.erb"), "@TEST\nRETURN").unwrap();
    let state = AppState::default();
    *state.project.lock().unwrap() = Some(ProjectHost::scan_quick(directory.path(), 1).unwrap());

    write_compiled_cache_chunk_inner(&state, b"first", true, false).unwrap();
    write_compiled_cache_chunk_inner(&state, b"second", false, true).unwrap();

    assert_eq!(
        fs::read(
            directory
                .path()
                .join(".rustyera/cache/compiled-project.reracache")
        )
        .unwrap(),
        b"firstsecond"
    );
    assert!(state.cache_writer.lock().unwrap().is_none());
}

#[test]
fn cancelled_compiled_cache_drops_its_temporary_writer() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("ERB")).unwrap();
    fs::write(directory.path().join("ERB/test.erb"), "@TEST\nRETURN").unwrap();
    let state = AppState::default();
    *state.project.lock().unwrap() = Some(ProjectHost::scan_quick(directory.path(), 1).unwrap());

    write_compiled_cache_chunk_inner(&state, b"partial", true, false).unwrap();
    cancel_compiled_cache_export_inner(&state).unwrap();

    assert!(state.cache_writer.lock().unwrap().is_none());
    assert!(
        !directory
            .path()
            .join(".rustyera/cache/compiled-project.reracache")
            .exists()
    );
}

#[test]
fn export_chunks_are_atomically_persisted() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("diagnosis.tar.zst");
    let state = AppState::default();

    write_atomic_file_chunk(
        &state.export_writer,
        Some(target.clone()),
        b"first",
        true,
        false,
    )
    .unwrap();
    assert!(!target.exists());
    write_atomic_file_chunk(&state.export_writer, None, b"second", false, true).unwrap();

    assert_eq!(fs::read(target).unwrap(), b"firstsecond");
    assert!(state.export_writer.lock().unwrap().is_none());
}

#[test]
fn missing_font_size_follows_the_game_configuration() {
    let normalized = Preferences {
        font_size_override_px: None,
        ..default_preferences()
    }
    .normalized();

    assert_eq!(normalized.font_size_override_px, None);
}

#[test]
fn obsolete_global_font_overrides_yield_to_project_configuration() {
    for schema_version in [1, 2] {
        let normalized = Preferences {
            schema_version,
            settings: BTreeMap::new(),
            font_family_override: Some("Legacy Font".into()),
            font_size_override_px: Some(24),
            image_scale: 1.75,
            master_volume: 0.4,
            trust_project_file_metadata: true,
            interaction_assist_mode: crate::preferences::InteractionAssistMode::Auto,
        }
        .normalized();

        assert_eq!(normalized.schema_version, 7);
        assert_eq!(normalized.font_family_override, None);
        assert_eq!(normalized.font_size_override_px, None);
        assert!((normalized.image_scale - 1.75).abs() < f64::EPSILON);
        assert!((normalized.master_volume - 0.4).abs() < f64::EPSILON);
        assert!(normalized.trust_project_file_metadata);
    }
}

#[test]
fn stored_camel_case_font_overrides_migrate_without_resetting_other_preferences() {
    let stored = serde_json::from_str::<Preferences>(
        r#"{
            "schemaVersion": 2,
            "fontFamilyOverride": "Legacy Font",
            "fontSizeOverridePx": 31,
            "imageScale": 1.75,
            "masterVolume": 0.4
        }"#,
    )
    .unwrap()
    .normalized();

    assert_eq!(stored.schema_version, 7);
    assert_eq!(stored.font_family_override, None);
    assert_eq!(stored.font_size_override_px, None);
    assert!((stored.image_scale - 1.75).abs() < f64::EPSILON);
    assert!((stored.master_volume - 0.4).abs() < f64::EPSILON);
}

#[test]
fn current_accessibility_font_overrides_remain_normalized() {
    let normalized = Preferences {
        schema_version: 3,
        settings: BTreeMap::new(),
        font_family_override: Some("Accessible Font".into()),
        font_size_override_px: Some(100),
        image_scale: 2.0,
        master_volume: 0.5,
        trust_project_file_metadata: true,
        interaction_assist_mode: crate::preferences::InteractionAssistMode::Auto,
    }
    .normalized();

    assert_eq!(normalized.font_family_override, None);
    assert_eq!(normalized.font_size_override_px, None);
    assert_eq!(
        normalized.settings.get("FontName").map(String::as_str),
        Some("Accessible Font")
    );
    assert_eq!(
        normalized.settings.get("FontSize").map(String::as_str),
        Some("72")
    );
    assert!((normalized.image_scale - 2.0).abs() < f64::EPSILON);
    assert!((normalized.master_volume - 0.5).abs() < f64::EPSILON);
}
