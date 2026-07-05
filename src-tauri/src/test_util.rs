//! Shared unit-test fixtures.

use base64::Engine;

use crate::png::{encode_rgba_png, png_dimensions_from_bytes};

pub(crate) const ONE_PIXEL_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
];

pub(crate) fn test_rgba_png(width: u32, height: u32, pixels: &[[u8; 4]]) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        image::Rgba(pixels[(y * width + x) as usize])
    });
    encode_rgba_png(image, "test image").expect("test png")
}

pub(crate) fn png_dimensions_from_data_url(data_url: &str) -> (u32, u32) {
    let (_, b64) = data_url.split_once(',').expect("data url comma");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .expect("thumbnail base64");
    png_dimensions_from_bytes(&bytes).expect("thumbnail png dimensions")
}
