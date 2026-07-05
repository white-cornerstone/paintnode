//! Shared PNG decode/encode and data-URL helpers.

use std::fs;
use std::io::Read;
use std::path::Path;

use base64::Engine;

pub(crate) const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub(crate) fn png_data_url_from_bytes(bytes: &[u8]) -> Option<String> {
    if !is_png(bytes) {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

pub(crate) fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

pub(crate) fn png_dimensions_from_bytes(bytes: &[u8]) -> Option<(u32, u32)> {
    if !is_png(bytes) || bytes.len() < 24 {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

pub(crate) fn png_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let bytes = fs::read(path)
        .map_err(|e| format!("Failed to read PNG dimensions at {}: {e}", path.display()))?;
    png_dimensions_from_bytes(&bytes)
        .ok_or_else(|| format!("PNG dimensions are invalid at {}.", path.display()))
}

pub(crate) fn decode_png_rgba(bytes: &[u8], label: &str) -> Result<image::RgbaImage, String> {
    if !is_png(bytes) {
        return Err(format!("{label} is not a PNG image."));
    }
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to decode {label} PNG: {e}"))?;
    Ok(image.to_rgba8())
}

pub(crate) fn encode_rgba_png(image: image::RgbaImage, label: &str) -> Result<Vec<u8>, String> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode {label} PNG: {e}"))?;
    Ok(bytes.into_inner())
}

pub(crate) fn file_has_png_signature(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut signature = [0_u8; 8];
    file.read_exact(&mut signature).is_ok() && signature == *PNG_SIGNATURE
}

pub(crate) fn png_data_url(bytes: &[u8]) -> Result<String, String> {
    if !is_png(bytes) {
        return Err("Generated output is not a valid PNG file.".into());
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

pub(crate) fn read_png_data_url(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("No output image found at {}: {e}", path.display()))?;
    png_data_url(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::ONE_PIXEL_PNG;

    #[test]
    fn png_data_url_accepts_png_signature() {
        let data_url = png_data_url(ONE_PIXEL_PNG).expect("valid PNG signature");
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn png_data_url_rejects_non_png() {
        let err = png_data_url(b"not a png").expect_err("invalid PNG should fail");
        assert!(err.contains("not a valid PNG"));
    }
}
