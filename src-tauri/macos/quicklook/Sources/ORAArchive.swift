import Foundation
import zlib

enum ORAArchive {
    private static let pngSignature = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    private static let previewEntries = ["mergedimage.png", "Thumbnails/thumbnail.png"]
    private static let thumbnailEntries = ["Thumbnails/thumbnail.png", "mergedimage.png"]

    static func previewPNGData(from url: URL) -> Data? {
        pngData(from: url, preferredEntries: previewEntries)
    }

    static func thumbnailPNGData(from url: URL) -> Data? {
        pngData(from: url, preferredEntries: thumbnailEntries)
    }

    private static func pngData(from url: URL, preferredEntries: [String]) -> Data? {
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            return nil
        }
        for entry in preferredEntries {
            if let png = extract(entry, from: data), png.starts(with: pngSignature) {
                return png
            }
        }
        return nil
    }

    private static func extract(_ name: String, from data: Data) -> Data? {
        guard let directory = centralDirectory(in: data) else {
            return nil
        }

        var offset = directory.offset
        let end = min(data.count, directory.offset + directory.size)
        while offset + 46 <= end, data.uint32LE(at: offset) == 0x02014b50 {
            let flags = data.uint16LE(at: offset + 8)
            let method = data.uint16LE(at: offset + 10)
            let compressedSize = Int(data.uint32LE(at: offset + 20))
            let uncompressedSize = Int(data.uint32LE(at: offset + 24))
            let nameLength = Int(data.uint16LE(at: offset + 28))
            let extraLength = Int(data.uint16LE(at: offset + 30))
            let commentLength = Int(data.uint16LE(at: offset + 32))
            let localHeaderOffset = Int(data.uint32LE(at: offset + 42))
            let nameStart = offset + 46
            let nameEnd = nameStart + nameLength
            guard nameEnd <= end else {
                return nil
            }

            let entryName = String(data: data[nameStart..<nameEnd], encoding: .utf8)
            if entryName == name {
                return extractLocalFile(
                    from: data,
                    offset: localHeaderOffset,
                    flags: flags,
                    method: method,
                    compressedSize: compressedSize,
                    uncompressedSize: uncompressedSize,
                )
            }
            offset = nameEnd + extraLength + commentLength
        }
        return nil
    }

    private static func centralDirectory(in data: Data) -> (offset: Int, size: Int)? {
        let minimumEOCDSize = 22
        guard data.count >= minimumEOCDSize else {
            return nil
        }
        let lowerBound = max(0, data.count - minimumEOCDSize - 65_535)
        var offset = data.count - minimumEOCDSize
        while offset >= lowerBound {
            if data.uint32LE(at: offset) == 0x06054b50 {
                let size = Int(data.uint32LE(at: offset + 12))
                let directoryOffset = Int(data.uint32LE(at: offset + 16))
                if directoryOffset >= 0, size >= 0, directoryOffset + size <= data.count {
                    return (directoryOffset, size)
                }
                return nil
            }
            offset -= 1
        }
        return nil
    }

    private static func extractLocalFile(
        from data: Data,
        offset: Int,
        flags: UInt16,
        method: UInt16,
        compressedSize: Int,
        uncompressedSize: Int,
    ) -> Data? {
        guard flags & 0x0001 == 0,
              offset + 30 <= data.count,
              data.uint32LE(at: offset) == 0x04034b50
        else {
            return nil
        }
        let nameLength = Int(data.uint16LE(at: offset + 26))
        let extraLength = Int(data.uint16LE(at: offset + 28))
        let payloadStart = offset + 30 + nameLength + extraLength
        let payloadEnd = payloadStart + compressedSize
        guard payloadStart >= 0, payloadEnd <= data.count else {
            return nil
        }

        let payload = data[payloadStart..<payloadEnd]
        switch method {
        case 0:
            return Data(payload)
        case 8:
            return inflateRawDeflate(payload, expectedSize: uncompressedSize)
        default:
            return nil
        }
    }

    private static func inflateRawDeflate(_ compressed: Data.SubSequence, expectedSize: Int) -> Data? {
        var stream = z_stream()
        let initStatus = inflateInit2_(&stream, -MAX_WBITS, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard initStatus == Z_OK else {
            return nil
        }
        defer {
            inflateEnd(&stream)
        }

        var output = Data()
        output.reserveCapacity(max(expectedSize, 32 * 1024))
        var input = Data(compressed)
        let chunkSize = 32 * 1024
        var status: Int32 = Z_OK

        input.withUnsafeMutableBytes { inputBuffer in
            guard let inputBase = inputBuffer.bindMemory(to: Bytef.self).baseAddress else {
                status = Z_STREAM_ERROR
                return
            }
            stream.next_in = inputBase
            stream.avail_in = uInt(inputBuffer.count)

            while status == Z_OK {
                var chunk = Data(count: chunkSize)
                chunk.withUnsafeMutableBytes { outputBuffer in
                    guard let outputBase = outputBuffer.bindMemory(to: Bytef.self).baseAddress else {
                        status = Z_STREAM_ERROR
                        return
                    }
                    stream.next_out = outputBase
                    stream.avail_out = uInt(outputBuffer.count)
                    status = inflate(&stream, Z_NO_FLUSH)
                    let produced = outputBuffer.count - Int(stream.avail_out)
                    if produced > 0 {
                        output.append(outputBase, count: produced)
                    }
                }
            }
        }

        return status == Z_STREAM_END ? output : nil
    }
}

private extension Data {
    func uint16LE(at offset: Int) -> UInt16 {
        guard offset + 2 <= count else {
            return 0
        }
        return UInt16(self[offset]) | (UInt16(self[offset + 1]) << 8)
    }

    func uint32LE(at offset: Int) -> UInt32 {
        guard offset + 4 <= count else {
            return 0
        }
        return UInt32(self[offset])
            | (UInt32(self[offset + 1]) << 8)
            | (UInt32(self[offset + 2]) << 16)
            | (UInt32(self[offset + 3]) << 24)
    }
}
