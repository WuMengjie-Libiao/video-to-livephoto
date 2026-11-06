import Foundation

@main struct LivePhotoTool {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            guard let command = args.first else { throw Failure("缺少命令") }
            switch command {
            case "prepare":
                guard args.count == 6, let time = Double(args[5]), time.isFinite, time >= 0 else { throw Failure("prepare 参数不合法") }
                let directory = URL(fileURLWithPath: args[3], isDirectory: true)
                let still = directory.appendingPathComponent("photo.JPG")
                let movie = directory.appendingPathComponent("photo.MOV")
                try writeStill(URL(fileURLWithPath: args[1]), still, identifier: args[4])
                try await writeMovie(URL(fileURLWithPath: args[2]), movie, identifier: args[4], stillTime: time)
                try await validate(still, movie)
                print("{\"validated\":true}")
            case "validate", "import":
                guard args.count == 3 else { throw Failure("需要静图和视频") }
                let still = URL(fileURLWithPath: args[1]), movie = URL(fileURLWithPath: args[2])
                if command == "import" { try await importPair(still, movie) }
                else { try await validate(still, movie) }
                print(command == "import" ? "{\"saved\":true}" : "{\"validated\":true}")
            default: throw Failure("未知命令")
            }
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}
