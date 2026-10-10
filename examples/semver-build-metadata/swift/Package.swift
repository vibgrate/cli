// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "demo",
    dependencies: [
        .package(url: "https://github.com/example/build-meta.git", exact: "1.2.3+build.7"),
    ]
)
