import AppKit
import QuickLookUI

final class PreviewViewController: NSViewController, QLPreviewingController {
    private let imageView = NSImageView()

    override func loadView() {
        imageView.imageAlignment = .alignCenter
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        view = imageView
    }

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        guard let data = ORAArchive.previewPNGData(from: url),
              let image = NSImage(data: data)
        else {
            handler(NSError(
                domain: "com.paintnode.openraster.quicklook",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unable to read OpenRaster preview image."],
            ))
            return
        }

        imageView.image = image
        preferredContentSize = image.size
        handler(nil)
    }
}
