fn main() {
    println!("cargo:rerun-if-changed=icons/icon-source.svg");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=resources/models/ggml-base.en.bin");
    tauri_build::build()
}
