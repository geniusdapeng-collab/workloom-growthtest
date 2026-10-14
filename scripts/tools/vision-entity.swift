// vision-entity.swift —— 实体级调色掩膜（macOS Vision；不联网、本地、可复现）
//
// 用法：vision-entity <image> <out-dir>
// 输出：out-dir/person.png（人物掩膜）、out-dir/food.png（食物掩膜，可能缺省）、faces.json，
//       并把一行 JSON 摘要写到 stdout：
//       {"personRatio":0.18,"faceCount":1,"foodRatio":0.22,"foodLabels":["soup"],...}
//
// 为什么需要它：镜头级调色只认"这一镜是什么"（美食镜 → 整帧暖黄），同镜的人像会被一起染黄。
// 实体级调色要先知道"人"和"食物"各自在画面里的位置，才能分别做美白 / 暖黄。
//   · 人物：VNGeneratePersonSegmentationRequest（人物分割掩膜）+ VNDetectFaceRectanglesRequest（人脸框）；
//   · 食物：VNGenerateForegroundInstanceMaskRequest（实例分割）逐实例裁剪 → VNClassifyImageRequest 分类，
//     命中食物词表才收进食物掩膜（避免把暖色桌面/木头当食物）；
//   · 缺少可靠实例支持时不作用；分类只能作标签证据，不能凭整帧标签猜测目标位置。
//
// 编译（首次自动，由 scripts/tools/edit-entity.mts / edit-post 负责）：
//   swiftc -O scripts/tools/vision-entity.swift -o <work-dir>/bin/vision-entity-<source-sha>
import Foundation
import Vision
import CoreImage
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct Summary: Codable {
  let personRatio: Double
  let personSkinRatio: Double?
  let personInstances: Int
  let personRequest: String
  let faceCount: Int
  let foodRatio: Double
  let foodLabels: [String]
  let instanceCount: Int
  let width: Int
  let height: Int
  let personMask: Bool
  let foodMask: Bool
  let notes: [String]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: vision-entity <image> <out-dir>\n".data(using: .utf8)!)
  exit(2)
}
let imageURL = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
do { try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true) }
catch { fail("无法创建掩膜目录：\(error.localizedDescription)") }
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  fail("无法读取图片：\(imageURL.path)")
}

let ciContext = CIContext(options: [.useSoftwareRenderer: false])
var notes: [String] = []

/**
 * 掩膜占比与包围盒。**按像素格式读取**：前景实例掩膜实测可能是
 * `kCVPixelFormatType_OneComponent32Float`（4 字节/像素），旧实现一律按 8-bit 单字节采样，
 * 会把 32-bit 缓冲读成乱码（实测同一张掩膜：缓冲算出 49%、真实 PNG 只有 4.9%）。
 * 采样步长按短边 /256，兼顾 4K 速度。
 */
func maskStats(_ buffer: CVPixelBuffer) -> (ratio: Double, bbox: CGRect) {
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return (0, .zero) }
  let width = CVPixelBufferGetWidth(buffer)
  let height = CVPixelBufferGetHeight(buffer)
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  let format = CVPixelBufferGetPixelFormatType(buffer)
  let step = max(1, min(width, height) / 256)
  var hits = 0
  var total = 0
  var minX = width, minY = height, maxX = -1, maxY = -1
  let bytes = base.assumingMemoryBound(to: UInt8.self)
  let isFloat = format == kCVPixelFormatType_OneComponent32Float
  var y = 0
  while y < height {
    var x = 0
    while x < width {
      let isOn: Bool
      if isFloat {
        let row = UnsafeRawPointer(base) + y * stride
        isOn = row.assumingMemoryBound(to: Float32.self)[x] >= 0.5
      } else {
        isOn = (bytes + y * stride)[x] >= 128
      }
      total += 1
      if isOn {
        hits += 1
        if x < minX { minX = x }
        if y < minY { minY = y }
        if x > maxX { maxX = x }
        if y > maxY { maxY = y }
      }
      x += step
    }
    y += step
  }
  guard hits > 0, maxX >= minX, maxY >= minY else { return (0, .zero) }
  let ratio = total > 0 ? Double(hits) / Double(total) : 0
  let bbox = CGRect(
    x: CGFloat(minX) / CGFloat(width),
    y: CGFloat(minY) / CGFloat(height),
    width: CGFloat(maxX - minX + 1) / CGFloat(width),
    height: CGFloat(maxY - minY + 1) / CGFloat(height)
  )
  return (ratio, bbox)
}

/** 从 CGImage 直接量掩膜覆盖率（与写出的 PNG 逐像素一致，口径统一）。 */
func coverage(of image: CGImage, threshold: UInt8 = 128) -> Double {
  let targetWidth = 256
  let targetHeight = max(1, Int((Double(targetWidth) * Double(image.height) / Double(max(1, image.width))).rounded()))
  guard let context = CGContext(
    data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8,
    bytesPerRow: targetWidth, space: CGColorSpaceCreateDeviceGray(),
    bitmapInfo: CGImageAlphaInfo.none.rawValue
  ) else { return 0 }
  context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
  guard let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { return 0 }
  var hits = 0
  for index in 0..<(targetWidth * targetHeight) where pixels[index] >= threshold { hits += 1 }
  return Double(hits) / Double(targetWidth * targetHeight)
}

func cgImageFromMask(_ buffer: CVPixelBuffer, width: Int, height: Int) -> CGImage? {
  let ci = CIImage(cvPixelBuffer: buffer)
  let scaleX = CGFloat(width) / max(1, ci.extent.width)
  let scaleY = CGFloat(height) / max(1, ci.extent.height)
  let scaled = ci.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
  return ciContext.createCGImage(scaled, from: CGRect(x: 0, y: 0, width: width, height: height))
}

func writePNG(_ image: CGImage, to url: URL) -> Bool {
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(destination, image, nil)
  return CGImageDestinationFinalize(destination)
}

/** 以同尺寸的灰度像素导出原始掩膜；PNG 与 PGM 共用同一缓冲，避免量化口径分裂。 */
func grayPixels(_ image: CGImage) -> [UInt8]? {
  guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
    bytesPerRow: image.width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  guard let data = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
  return Array(UnsafeBufferPointer(start: data, count: image.width * image.height))
}
func grayImage(_ pixels: [UInt8], width: Int, height: Int) -> CGImage? {
  let data = Data(pixels)
  guard let provider = CGDataProvider(data: data as CFData) else { return nil }
  return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}
func writeMask(_ image: CGImage, name: String) -> Bool {
  guard let pixels = grayPixels(image) else { return false }
  // 与 CGImageDestination 写出的 PNG 共用相同的上到下光栅顺序。
  var pgm = Data("P5\n\(image.width) \(image.height)\n255\n".utf8)
  pgm.append(contentsOf: pixels)
  do { try pgm.write(to: outDir.appendingPathComponent("\(name).pgm"), options: .atomic) }
  catch { notes.append("\(name) PGM 写入失败：\(error.localizedDescription)"); return false }
  guard writePNG(image, to: outDir.appendingPathComponent("\(name).png")) else {
    notes.append("\(name) PNG 写入失败"); return false
  }
  return true
}

/** 肤色带只在人物分割支持内起作用；再排除食物支持，衣服与背景不会随人像一起去黄。 */
func skinMask(image: CGImage, support: CGImage, exclude: CGImage?) -> (image: CGImage?, ratio: Double) {
  let width = image.width, height = image.height
  guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
    bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
    let mask = grayPixels(support) else { return (nil, 0) }
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  guard let rgb = context.data?.assumingMemoryBound(to: UInt8.self) else { return (nil, 0) }
  let excluded = exclude.flatMap(grayPixels)
  var result = [UInt8](repeating: 0, count: width * height), masked = 0, skin = 0
  for i in 0..<result.count where mask[i] >= 128 {
    masked += 1
    if let excluded, excluded[i] >= 32 { continue }
    let r = Double(rgb[i * 4]), g = Double(rgb[i * 4 + 1]), b = Double(rgb[i * 4 + 2])
    let y = 0.299 * r + 0.587 * g + 0.114 * b
    let cb = -0.169 * r - 0.331 * g + 0.5 * b + 128
    let cr = 0.5 * r - 0.419 * g - 0.081 * b + 128
    if y > 30 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 { result[i] = mask[i]; skin += 1 }
  }
  return (grayImage(result, width: width, height: height), masked > 0 ? Double(skin) / Double(masked) : 0)
}

// ① 人物分割
var personRatio = 0.0
var personMaskWritten = false
var personSkinRatio: Double? = nil
var personInstances = 0
var personRequest = "none"
var personSupport: CGImage? = nil
var foodSupport: CGImage? = nil
/**
 * 先用"人物**实例**分割"（macOS 14+）：它只在画面里真有人物实例时给掩膜。
 * 实测（2026-10-11 俯拍食物镜）：旧的通用人物分割会把盘子/桌面误判成"人"（掩膜占比 63%），
 * 而人物实例分割在同一帧直接无结果——这是"人像美白不能洗到食物上"的关键门控。
 */
if #available(macOS 14.0, *) {
  let request = VNGeneratePersonInstanceMaskRequest()
  do {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    if let observation = request.results?.first, !observation.allInstances.isEmpty {
      personInstances = observation.allInstances.count
      personRequest = "instance"
      if let union = try? observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler) {
        if let mask = cgImageFromMask(union, width: cgImage.width, height: cgImage.height) {
          personRatio = coverage(of: mask)
          personSupport = mask
        }
      }
    }
  } catch {
    notes.append("人物实例分割失败：\(error.localizedDescription)")
  }
}
if personRequest == "none", #available(macOS 12.0, *) {
  /** 兜底：通用人物分割（实例分割不可用时）；调用侧需结合人脸/肤色证据再决定是否美白。 */
  let request = VNGeneratePersonSegmentationRequest()
  request.qualityLevel = .balanced
  request.outputPixelFormat = kCVPixelFormatType_OneComponent8
  do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    if let observation = request.results?.first {
      personRequest = "segmentation"
      if let mask = cgImageFromMask(observation.pixelBuffer, width: cgImage.width, height: cgImage.height) {
        personRatio = coverage(of: mask)
        personSupport = mask
      }
    } else {
      notes.append("人物分割：无结果")
    }
  } catch {
    notes.append("人物分割失败：\(error.localizedDescription)")
  }
} else if personRequest == "none" {
  notes.append("人物实例分割不可用且系统低于 macOS 12：无人物掩膜")
}

// ② 人脸框（Vision 坐标原点在左下 → 转成左上原点的归一化框）
var faces: [CGRect] = []
do {
  let request = VNDetectFaceRectanglesRequest()
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
  faces = (request.results ?? []).map { observation in
    let box = observation.boundingBox
    return CGRect(
      x: min(max(0, box.origin.x), 1),
      y: min(max(0, 1 - box.origin.y - box.height), 1),
      width: min(max(0, box.width), 1),
      height: min(max(0, box.height), 1)
    )
  }
} catch {
  notes.append("人脸检测失败：\(error.localizedDescription)")
}
let faceJSON = (try? JSONSerialization.data(
  withJSONObject: faces.map { ["x": Double($0.origin.x), "y": Double($0.origin.y), "w": Double($0.width), "h": Double($0.height)] },
  options: [.sortedKeys]
)) ?? Data()
do { try faceJSON.write(to: outDir.appendingPathComponent("faces.json")) }
catch { notes.append("人脸证据写入失败：\(error.localizedDescription)") }

// ③ 食物实例：逐实例裁剪分类，命中词表才收
let FOOD_HINTS: [String] = [
  "food", "dish", "meal", "cuisine", "dessert", "snack", "breakfast", "lunch", "dinner", "banquet",
  "noodle", "soup", "broth", "stew", "hotpot", "dumpling", "rice", "bun", "bread", "pasta", "porridge",
  "meat", "beef", "pork", "chicken", "lamb", "fish", "seafood", "shrimp", "egg",
  "vegetable", "fruit", "apple", "salad", "cake", "pastry", "pizza", "burger", "sushi", "barbecue",
  "食物", "美食", "汤", "面", "饭", "肉", "鱼", "水果", "甜点", "小吃", "火锅", "饺子", "包子", "烧烤", "菜",
]

func isFoodLabel(_ label: String) -> Bool {
  let words = label.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
  return FOOD_HINTS.contains { hint in
    words.contains { $0 == hint || $0 == hint + "s" || $0 == hint + "es" }
  }
}

func classify(_ image: CGImage) -> [String] {
  let request = VNClassifyImageRequest()
  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? [])
      .filter { $0.confidence >= 0.12 }
      .map { $0.identifier }
  } catch {
    notes.append("整帧/实例分类失败：\(error.localizedDescription)")
    return []
  }
}

func crop(_ image: CGImage, normalized: CGRect) -> CGImage? {
  let width = CGFloat(image.width)
  let height = CGFloat(image.height)
  let rect = CGRect(
    x: max(0, normalized.origin.x * width),
    y: max(0, normalized.origin.y * height),
    width: max(2, normalized.width * width),
    height: max(2, normalized.height * height)
  ).intersection(CGRect(x: 0, y: 0, width: width, height: height))
  guard rect.width >= 8, rect.height >= 8 else { return nil }
  return image.cropping(to: rect)
}

var foodRatio = 0.0
var foodLabels: [String] = []
var instanceCount = 0
var foodMaskWritten = false
if #available(macOS 14.0, *) {
  let request = VNGenerateForegroundInstanceMaskRequest()
  do {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    if let observation = request.results?.first {
      instanceCount = observation.allInstances.count
      var accepted = IndexSet()
      for index in observation.allInstances {
        let buffer: CVPixelBuffer
        do { buffer = try observation.generateScaledMaskForImage(forInstances: IndexSet(integer: index), from: handler) }
        catch { notes.append("前景实例掩膜失败：\(error.localizedDescription)"); continue }
        let stats = maskStats(buffer)
        guard stats.ratio >= 0.002, let whole = crop(cgImage, normalized: stats.bbox) else { continue }
        let hits = classify(whole).filter(isFoodLabel)
        guard !hits.isEmpty else { continue }
        // 前景实例没有 food 语义保证；过大实例容易混入桌面、人物，不能靠矩形或椭圆猜位置。
        guard stats.ratio <= 0.5 else {
          notes.append("食物分类候选占比 \(Int(stats.ratio * 100))% 过大，跳过含混前景实例")
          continue
        }
        accepted.insert(index)
        foodLabels.append(contentsOf: hits.prefix(3))
      }
      if !accepted.isEmpty {
        do {
          let union = try observation.generateScaledMaskForImage(forInstances: accepted, from: handler)
          if let mask = cgImageFromMask(union, width: cgImage.width, height: cgImage.height) {
            foodSupport = mask
            foodRatio = coverage(of: mask)
            foodMaskWritten = writeMask(mask, name: "food")
          }
        } catch { notes.append("食物实例并集失败：\(error.localizedDescription)") }
      }
    } else { notes.append("前景实例分割无结果；无食物掩膜") }
  } catch { notes.append("前景实例分割失败：\(error.localizedDescription)") }
} else { notes.append("系统低于 macOS 14：无食物实例掩膜，不猜测几何位置") }
notes.append("食物证据为前景实例加裁剪分类启发式，不是 food 语义分割保证")
if let support = personSupport {
  let skin = skinMask(image: cgImage, support: support, exclude: foodSupport)
  personSkinRatio = skin.ratio
  if let mask = skin.image, coverage(of: mask) >= 0.001 {
    personRatio = coverage(of: mask)
    personMaskWritten = writeMask(mask, name: "person")
  } else { personRatio = 0; notes.append("人物支持内未获得可用肤色掩膜，不作用") }
}

let summary = Summary(
  personRatio: (personRatio * 1000).rounded() / 1000,
  personSkinRatio: personSkinRatio.map { ($0 * 1000).rounded() / 1000 },
  personInstances: personInstances,
  personRequest: personRequest,
  faceCount: faces.count,
  foodRatio: (foodRatio * 1000).rounded() / 1000,
  foodLabels: Array(Set(foodLabels)).sorted().prefix(6).map { $0 },
  instanceCount: instanceCount,
  width: cgImage.width,
  height: cgImage.height,
  personMask: personMaskWritten,
  foodMask: foodMaskWritten,
  notes: notes
)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let data = try? encoder.encode(summary), let text = String(data: data, encoding: .utf8) {
  print(text)
} else {
  print("{}")
}
