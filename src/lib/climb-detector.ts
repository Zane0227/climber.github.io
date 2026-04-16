/**
 * 攀岩上墙/下墙自动检测
 *
 * 原理：
 * 1. 扫描整个视频（低帧率采样），记录每帧的人体位置（尤其是 Y 坐标变化）
 * 2. 上墙：人体的 Y 坐标开始持续下降（在画面中向上移动）
 * 3. 下墙：人体的 Y 坐标回到底部或消失
 *
 * 检测策略：
 * - 分析人体 bbox 中心的 Y 轨迹
 * - 找到第一次「开始向上移动」的帧 → 上墙时间
 * - 找到最后一次「回到底部 / 消失」的帧 → 下墙时间
 */

export interface ClimbPhase {
  wallOnTime: number;  // 上墙时间(秒)
  wallOffTime: number; // 下墙时间(秒)
  confidence: number;  // 检测置信度 0-1
}

export interface ScanFrame {
  time: number;
  personY: number | null; // 归一化 Y 中心 (0=顶部, 1=底部)
  personH: number | null; // 归一化人体高度
  hasDetection: boolean;
}

/**
 * 从扫描帧数据中检测上墙/下墙时间点
 */
export function detectClimbPhases(frames: ScanFrame[], duration: number): ClimbPhase {
  if (frames.length < 5) {
    return { wallOnTime: 0, wallOffTime: duration, confidence: 0 };
  }

  // 填充缺失帧（线性插值）
  const filled = fillMissing(frames);

  // 提取 Y 轨迹（使用滑动窗口平滑）
  const windowSize = Math.max(3, Math.floor(filled.length / 20));
  const smoothedY = smoothTrajectory(
    filled.map((f) => f.personY ?? 0.9),
    windowSize
  );

  // 计算 Y 的变化率（向上为负）
  const velocities: number[] = [];
  for (let i = 1; i < smoothedY.length; i++) {
    velocities.push(smoothedY[i] - smoothedY[i - 1]);
  }
  velocities.unshift(0);

  // === 检测上墙 ===
  // 找到人体从底部区域开始持续上移的时间点
  // 条件：Y 从 > 0.6 开始持续下降（向上），连续多帧速度为负
  let wallOnIdx = 0;
  const minConsecutiveUp = Math.max(3, Math.floor(filled.length * 0.05));

  for (let i = 0; i < filled.length - minConsecutiveUp; i++) {
    if (smoothedY[i] > 0.5) {
      // 人在画面下半部分
      let consecutiveUp = 0;
      for (let j = i; j < Math.min(i + minConsecutiveUp * 3, velocities.length); j++) {
        if (velocities[j] < -0.005) {
          consecutiveUp++;
        } else {
          consecutiveUp = Math.max(0, consecutiveUp - 1);
        }
      }
      if (consecutiveUp >= minConsecutiveUp) {
        // 回退一点点，留一些准备画面
        wallOnIdx = Math.max(0, i - Math.floor(minConsecutiveUp * 0.5));
        break;
      }
    }
  }

  // === 检测下墙 ===
  // 从末尾回溯，找到人体最后在高处（Y < 0.5）然后下降到底部的时间点
  let wallOffIdx = filled.length - 1;

  // 找到最后一次在高处的位置
  let lastHighIdx = -1;
  for (let i = filled.length - 1; i >= wallOnIdx; i--) {
    if (smoothedY[i] < 0.5 && filled[i].hasDetection) {
      lastHighIdx = i;
      break;
    }
  }

  if (lastHighIdx > 0) {
    // 从最高点往后找，找到人体回到底部或消失的时间
    for (let i = lastHighIdx; i < filled.length; i++) {
      if (!filled[i].hasDetection || smoothedY[i] > 0.75) {
        wallOffIdx = Math.min(filled.length - 1, i + Math.floor(minConsecutiveUp * 0.5));
        break;
      }
    }
  }

  // 也检查是否后面有一段持续无检测（人离开画面）
  let lastDetectionIdx = filled.length - 1;
  for (let i = filled.length - 1; i >= wallOnIdx; i--) {
    if (filled[i].hasDetection) {
      lastDetectionIdx = i;
      break;
    }
  }

  // 如果最后一段长时间无检测，说明人走了
  const noDetectionTail = filled.length - 1 - lastDetectionIdx;
  if (noDetectionTail > minConsecutiveUp * 2) {
    wallOffIdx = Math.min(
      wallOffIdx,
      lastDetectionIdx + Math.floor(minConsecutiveUp * 0.5)
    );
  }

  wallOffIdx = Math.max(wallOnIdx + 1, wallOffIdx);

  // 计算置信度
  const detectionRate = filled.filter((f) => f.hasDetection).length / filled.length;
  const hasMovement =
    Math.max(...smoothedY) - Math.min(...smoothedY) > 0.2;
  const confidence = detectionRate * (hasMovement ? 0.8 : 0.3) +
    (wallOnIdx > 0 ? 0.1 : 0) +
    (wallOffIdx < filled.length - 1 ? 0.1 : 0);

  return {
    wallOnTime: filled[wallOnIdx].time,
    wallOffTime: filled[wallOffIdx].time,
    confidence: Math.min(1, confidence),
  };
}

function fillMissing(frames: ScanFrame[]): ScanFrame[] {
  const result = [...frames];
  let lastValid: number | null = null;

  for (let i = 0; i < result.length; i++) {
    if (result[i].personY !== null) {
      // 回填之前的空缺
      if (lastValid !== null && i - lastValid > 1) {
        const startY = result[lastValid].personY!;
        const endY = result[i].personY!;
        for (let j = lastValid + 1; j < i; j++) {
          const t = (j - lastValid) / (i - lastValid);
          result[j] = {
            ...result[j],
            personY: startY + (endY - startY) * t,
          };
        }
      }
      lastValid = i;
    }
  }

  // 尾部填充
  if (lastValid !== null) {
    for (let i = lastValid + 1; i < result.length; i++) {
      result[i] = { ...result[i], personY: 0.9 }; // 假设人回到底部
    }
  }

  return result;
}

function smoothTrajectory(values: number[], windowSize: number): number[] {
  const result: number[] = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      count++;
    }
    result.push(sum / count);
  }

  return result;
}
