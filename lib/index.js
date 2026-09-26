// This package ships no code entry of its own.
//
// The bundle patch (cordis.patch.yml) mounts lib/relay-direct.mjs as a cordis
// patch entry, and the profile loader loads that module directly. Nothing
// imports this file; it exists so `main` resolves to something real.
export {};
