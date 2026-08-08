pub struct ImageMetadata {
    pub width: u32,
    pub height: u32,
    pub format: &'static str,
    pub animated: bool,
}

pub fn decode(data: &[u8]) -> Option<ImageMetadata> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return png(data);
    }
    if data.starts_with(b"BM") {
        return bmp(data);
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return gif(data);
    }
    if data.starts_with(&[0xff, 0xd8]) {
        return jpeg(data);
    }
    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        return webp(data);
    }
    None
}

fn metadata(
    width: u32,
    height: u32,
    format: &'static str,
    animated: bool,
) -> Option<ImageMetadata> {
    (width > 0 && height > 0).then_some(ImageMetadata {
        width,
        height,
        format,
        animated,
    })
}

fn png(data: &[u8]) -> Option<ImageMetadata> {
    if data.get(12..16) != Some(b"IHDR") {
        return None;
    }
    let width = be_u32(data, 16)?;
    let height = be_u32(data, 20)?;
    let mut offset = 8usize;
    let mut animated = false;
    while offset.checked_add(12)? <= data.len() {
        let length = usize::try_from(be_u32(data, offset)?).ok()?;
        let end = offset.checked_add(12)?.checked_add(length)?;
        if end > data.len() {
            break;
        }
        match data.get(offset + 4..offset + 8) {
            Some(b"acTL") => {
                animated = true;
                break;
            }
            Some(b"IEND") => break,
            _ => offset = end,
        }
    }
    metadata(width, height, "png", animated)
}

fn bmp(data: &[u8]) -> Option<ImageMetadata> {
    let dib_size = le_u32(data, 14)?;
    let (width, height) = if dib_size == 12 {
        (u32::from(le_u16(data, 18)?), u32::from(le_u16(data, 20)?))
    } else if dib_size >= 40 {
        (
            le_i32(data, 18)?.unsigned_abs(),
            le_i32(data, 22)?.unsigned_abs(),
        )
    } else {
        return None;
    };
    metadata(width, height, "bmp", false)
}

fn gif(data: &[u8]) -> Option<ImageMetadata> {
    let width = u32::from(le_u16(data, 6)?);
    let height = u32::from(le_u16(data, 8)?);
    metadata(
        width,
        height,
        "gif",
        data.windows(b"NETSCAPE2.0".len())
            .any(|window| window == b"NETSCAPE2.0"),
    )
}

fn jpeg(data: &[u8]) -> Option<ImageMetadata> {
    let mut offset = 2usize;
    while offset < data.len() {
        while data.get(offset).is_some_and(|byte| *byte != 0xff) {
            offset += 1;
        }
        while data.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *data.get(offset)?;
        offset += 1;
        if marker == 0x01 || (0xd0..=0xd9).contains(&marker) {
            continue;
        }
        let length = usize::from(be_u16(data, offset)?);
        let end = offset.checked_add(length)?;
        if length < 2 || end > data.len() {
            return None;
        }
        let is_start_of_frame =
            (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
        if is_start_of_frame {
            if length < 7 {
                return None;
            }
            return metadata(
                u32::from(be_u16(data, offset + 5)?),
                u32::from(be_u16(data, offset + 3)?),
                "jpeg",
                false,
            );
        }
        offset = end;
    }
    None
}

fn webp(data: &[u8]) -> Option<ImageMetadata> {
    let mut offset = 12usize;
    while offset.checked_add(8)? <= data.len() {
        let kind = data.get(offset..offset + 4)?;
        let length = usize::try_from(le_u32(data, offset + 4)?).ok()?;
        let payload = offset.checked_add(8)?;
        let end = payload.checked_add(length)?;
        if end > data.len() {
            return None;
        }
        if kind == b"VP8X" && length >= 10 {
            return metadata(
                uint24_le(data, payload + 4)?.checked_add(1)?,
                uint24_le(data, payload + 7)?.checked_add(1)?,
                "webp",
                data[payload] & 0x02 != 0,
            );
        }
        if kind == b"VP8 "
            && length >= 10
            && data.get(payload + 3..payload + 6) == Some(&[0x9d, 0x01, 0x2a])
        {
            return metadata(
                u32::from(le_u16(data, payload + 6)? & 0x3fff),
                u32::from(le_u16(data, payload + 8)? & 0x3fff),
                "webp",
                false,
            );
        }
        if kind == b"VP8L" && length >= 5 && data.get(payload) == Some(&0x2f) {
            let bits = le_u32(data, payload + 1)?;
            return metadata(
                (bits & 0x3fff) + 1,
                ((bits >> 14) & 0x3fff) + 1,
                "webp",
                false,
            );
        }
        offset = end.checked_add(length & 1)?;
    }
    None
}

fn be_u16(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        data.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn be_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_u16(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        data.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn le_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_i32(data: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn uint24_le(data: &[u8], offset: usize) -> Option<u32> {
    Some(
        u32::from(*data.get(offset)?)
            | (u32::from(*data.get(offset + 1)?) << 8)
            | (u32::from(*data.get(offset + 2)?) << 16),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_png_dimensions() {
        let mut png = vec![0; 24];
        png[..8].copy_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&320_u32.to_be_bytes());
        png[20..24].copy_from_slice(&180_u32.to_be_bytes());
        let decoded = decode(&png).unwrap();
        assert_eq!((decoded.width, decoded.height), (320, 180));
        assert_eq!(decoded.format, "png");
        assert!(!decoded.animated);
    }
}
