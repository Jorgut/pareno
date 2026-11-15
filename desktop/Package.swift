// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ParenoDesktop",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")
    ],
    targets: [
        .executableTarget(
            name: "ParenoDesktop",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/ParenoDesktop"
        )
    ]
)
