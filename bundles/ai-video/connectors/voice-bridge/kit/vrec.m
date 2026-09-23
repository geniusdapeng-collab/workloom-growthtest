// 小织声音工坊 · 原生录音器（vrec）
//
// 为什么需要它：原设计用 ffmpeg 的 avfoundation 采集，但从"双击打开的应用"里启动 ffmpeg 时，
// macOS 的隐私保护把这次采集判给 ffmpeg 这个**没有用途说明的普通二进制**，结果是**静默拒绝**——
// 不弹权限框、文件里全是数字静音（实测 23:31 / 23:36 两次用户录音 mean=max=-91.0 dB），
// 用户明明念完了，应用却报"没有检测到说话声"。
//
// 本程序编译进应用包内（Contents/MacOS/vrec），由应用进程派生：TCC 会把请求归属到**应用**，
// 于是首次录音会正常弹「『小织声音工坊』想访问麦克风」，授权后即可录音；
// 若权限被拒，程序以退出码 3 + permission_denied 明确报错，让界面能给出可操作的指引。
//
// 用法：
//   vrec --out /path/out.wav --seconds 12        # 录音（24kHz 单声道 16bit PCM WAV）
//   vrec --check                                  # 只检查权限（不录音）
// 退出码：0 成功；2 参数错误；3 麦克风权限被拒；4 录音失败

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

static void fail(int code, NSString *message) {
  fprintf(stderr, "%s\n", [message UTF8String]);
  exit(code);
}

/** 同步等待权限结果（最多 30 秒），返回是否已授权。 */
static BOOL ensurePermission(void) {
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (status == AVAuthorizationStatusAuthorized) return YES;
  if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) return NO;

  __block BOOL granted = NO;
  __block BOOL answered = NO;
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL ok) {
    granted = ok;
    answered = YES;
  }];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30.0];
  while (!answered && [deadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  if (!answered) return NO;
  return granted;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *outPath = nil;
    double seconds = 12.0;
    BOOL checkOnly = NO;

    for (int i = 1; i < argc; i++) {
      NSString *arg = [NSString stringWithUTF8String:argv[i]];
      if ([arg isEqualToString:@"--out"] && i + 1 < argc) {
        outPath = [NSString stringWithUTF8String:argv[++i]];
      } else if ([arg isEqualToString:@"--seconds"] && i + 1 < argc) {
        seconds = [[NSString stringWithUTF8String:argv[++i]] doubleValue];
      } else if ([arg isEqualToString:@"--check"]) {
        checkOnly = YES;
      } else {
        fail(2, [NSString stringWithFormat:@"未知参数：%@", arg]);
      }
    }

    if (!checkOnly && (outPath == nil || outPath.length == 0)) fail(2, @"缺少 --out");
    if (seconds < 0.5 || seconds > 600) fail(2, @"--seconds 需在 0.5–600 之间");

    if (!ensurePermission()) {
      fail(3, @"permission_denied: 麦克风权限被拒，请在 系统设置 → 隐私与安全性 → 麦克风 里允许『小织声音工坊』");
    }
    if (checkOnly) {
      printf("{\"permission\":\"granted\"}\n");
      return 0;
    }

    NSURL *url = [NSURL fileURLWithPath:outPath];
    NSDictionary *settings = @{
      AVFormatIDKey: @(kAudioFormatLinearPCM),
      AVSampleRateKey: @24000.0,
      AVNumberOfChannelsKey: @1,
      AVLinearPCMBitDepthKey: @16,
      AVLinearPCMIsFloatKey: @NO,
      AVLinearPCMIsBigEndianKey: @NO,
    };
    NSError *error = nil;
    AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:url settings:settings error:&error];
    if (recorder == nil) {
      fail(4, [NSString stringWithFormat:@"recorder_init_failed: %@", error.localizedDescription ?: @"unknown"]);
    }
    if (![recorder recordForDuration:seconds]) {
      fail(4, @"record_start_failed: 无法开始录音（设备可能被其它程序独占）");
    }
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds + 15.0];
    while ([recorder isRecording] && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    [recorder stop];
    if (![[NSFileManager defaultManager] fileExistsAtPath:outPath]) {
      fail(4, @"record_failed: 录音文件没有生成");
    }
    printf("{\"out\":\"%s\",\"seconds\":%.3f}\n", [outPath UTF8String], seconds);
    return 0;
  }
}
