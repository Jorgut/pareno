import AppKit

enum BrandAssets {
    static func mark(size: CGFloat? = nil) -> NSImage? {
        guard let url = Bundle.main.url(forResource: "ParenoMark", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        if let size {
            image.size = NSSize(width: size, height: size)
        }
        return image
    }
}
