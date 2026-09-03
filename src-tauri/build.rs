fn main() {
    // whisper.cpp (via whisper-rs) uses C++17 std::filesystem — requires macOS 10.15+.
    #[cfg(target_os = "macos")]
    {
        const DEPLOYMENT_TARGET: &str = "10.15";
        std::env::set_var("MACOSX_DEPLOYMENT_TARGET", DEPLOYMENT_TARGET);
        println!("cargo:rustc-env=MACOSX_DEPLOYMENT_TARGET={DEPLOYMENT_TARGET}");
    }

    println!("cargo:rerun-if-changed=icons/icon-source.svg");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=resources/models/ggml-base.en.bin");
    tauri_build::build()
}
