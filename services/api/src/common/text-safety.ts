/**
 * Characters that never belong in text staff or users type and others read: C0/C1 controls, DEL, zero-width
 * and direction marks (U+200B-U+200F, U+2060, U+FEFF) and bidi embeddings, overrides and isolates
 * (U+202A-U+202E, U+2066-U+2069). They can hide or reorder what a reviewer sees in a reason or a name.
 */
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
