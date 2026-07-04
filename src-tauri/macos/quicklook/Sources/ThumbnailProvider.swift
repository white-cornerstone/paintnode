import AppKit
import QuickLookThumbnailing

final class ThumbnailProvider: QLThumbnailProvider {
    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void,
    ) {
        guard let data = ORAArchive.previewPNGData(from: request.fileURL),
              let image = NSImage(data: data)
        else {
            handler(nil, nil)
            return
        }

        let contextSize = fittedSize(for: image.size, within: request.maximumSize)
        let reply = QLThumbnailReply(contextSize: contextSize) { context in
            draw(image, in: context, size: contextSize)
            return true
        }
        handler(reply, nil)
    }
}

private func fittedSize(for imageSize: NSSize, within maximumSize: CGSize) -> CGSize {
    guard imageSize.width > 0, imageSize.height > 0 else {
        return maximumSize
    }
    let scale = min(maximumSize.width / imageSize.width, maximumSize.height / imageSize.height)
    return CGSize(
        width: max(1, imageSize.width * scale),
        height: max(1, imageSize.height * scale),
    )
}

private func draw(_ image: NSImage, in context: CGContext, size: CGSize) {
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    image.draw(
        in: CGRect(origin: .zero, size: size),
        from: .zero,
        operation: .copy,
        fraction: 1,
    )
    NSGraphicsContext.restoreGraphicsState()
}
