//! Traits and implementations for encoding types into a series of bytes and
//! decoding bytes back into types.
//!
//! Examples attached to optional codecs are marked `ignore`: they need the
//! corresponding `bincode_2`/`postcard_1_0`/`rmp_serde_1_3` feature enabled to
//! compile and would otherwise fail the default doctest run.

#[cfg(any(all(feature = "serde", feature = "bincode_1_3"), doc))]
pub mod bincode_1_3;
#[cfg(any(all(feature = "serde", feature = "bincode_2"), doc))]
pub mod bincode_2;
#[cfg(any(all(feature = "serde", feature = "postcard_1_0"), doc))]
pub mod postcard_1_0;
#[cfg(any(all(feature = "serde", feature = "rmp_serde_1_3"), doc))]
pub mod rmp_serde_1_3;

/// Encode trait for your own encoding method.
///
/// Example:
/// ```rust
/// use serde::Serialize;
/// pub struct Bincode;
///
/// impl<T: Serialize> native_model::Encode<T> for Bincode {
///     type Error = bincode_1_3::Error;
///     fn encode(obj: &T) -> Result<Vec<u8>, bincode_1_3::Error> {
///         bincode_1_3::serialize(obj)
///     }
/// }
/// ```
pub trait Encode<T> {
    type Error;
    /// Encodes a `T` type into a series of bytes.
    ///
    /// # Errors
    ///
    /// The errors returned from this function depend on the trait implementor
    /// (the serializer), i.e. `bincode_1_3`.
    fn encode(obj: &T) -> Result<Vec<u8>, Self::Error>;
}

/// Decode trait for your own decoding method.
///
/// Example:
/// ```rust
/// use serde::Deserialize;
/// pub struct Bincode;
///
/// impl<T: for<'a> Deserialize<'a>> native_model::Decode<T> for Bincode {
///     type Error = bincode_1_3::Error;
///     fn decode(data: Vec<u8>) -> Result<T, bincode_1_3::Error> {
///         bincode_1_3::deserialize(&data[..])
///     }
/// }
/// ```
pub trait Decode<T> {
    type Error;
    /// Decodes a series of bytes back into a `T` type.
    ///
    /// # Errors
    ///
    /// The errors returned from this function depend on the trait implementor
    /// (the deserializer), i.e. `bincode_1_3`.
    fn decode(data: Vec<u8>) -> Result<T, Self::Error>;
}
