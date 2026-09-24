mod context;

use thiserror::Error;

pub use context::GpuContext;
pub use wgpu;

pub const GPU_TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;
pub const FULLSCREEN_SHADER_SOURCE: &str = include_str!("shaders/fullscreen.wgsl");

#[derive(Debug, Error)]
pub enum GpuError {
    #[error("No WebGPU adapter is available")]
    AdapterUnavailable,
    #[error("Failed to request a WebGPU device: {0}")]
    RequestDevice(#[from] wgpu::RequestDeviceError),
    #[error("Failed to create a WebGPU surface: {0}")]
    CreateSurface(#[from] wgpu::CreateSurfaceError),
    #[error("The output surface does not support the required texture format")]
    UnsupportedSurfaceFormat,
    /// The WebGL fallback path could not read pixels back out of a canvas.
    ///
    /// A `CanvasRenderingContext2d` can be unavailable for reasons that have
    /// nothing to do with our code — the canvas already being attached to a
    /// different context type, or a lost context — and `getImageData` fails on
    /// a canvas the browser considers tainted. These were `expect()` calls, and
    /// on wasm a panic does not unwind: it aborts into an unreachable trap, and
    /// the message is only recoverable through the panic hook. Returning an
    /// error instead keeps these on the same path as every other GPU failure,
    /// where the caller already knows how to report a reason.
    #[error("Failed to read pixels from the canvas: {0}")]
    CanvasReadback(&'static str),
}
