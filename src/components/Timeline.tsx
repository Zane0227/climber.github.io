"use client";

import React, { useRef, useCallback, useState, useEffect } from "react";

interface TimelineProps {
  duration: number; // 视频总时长(秒)
  currentTime: number; // 当前播放时间(秒)
  trimStart: number; // 裁切起点(秒)
  trimEnd: number; // 裁切终点(秒)
  isProcessing: boolean;
  onSeek: (time: number) => void;
  onTrimChange: (start: number, end: number) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

export default function Timeline({
  duration,
  currentTime,
  trimStart,
  trimEnd,
  isProcessing,
  onSeek,
  onTrimChange,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<
    "playhead" | "trimStart" | "trimEnd" | null
  >(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);

  const getTimeFromX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || duration <= 0) return 0;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, type: "playhead" | "trimStart" | "trimEnd") => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(type);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const time = getTimeFromX(e.clientX);

      // 鼠标悬停时间提示
      if (!dragging) {
        const rect = trackRef.current?.getBoundingClientRect();
        if (rect) {
          setHoverTime(time);
          setHoverX(e.clientX - rect.left);
        }
        return;
      }

      if (dragging === "playhead") {
        onSeek(time);
      } else if (dragging === "trimStart") {
        const newStart = Math.max(0, Math.min(time, trimEnd - 0.5));
        onTrimChange(newStart, trimEnd);
      } else if (dragging === "trimEnd") {
        const newEnd = Math.min(duration, Math.max(time, trimStart + 0.5));
        onTrimChange(trimStart, newEnd);
      }
    },
    [dragging, getTimeFromX, onSeek, onTrimChange, trimStart, trimEnd, duration]
  );

  const handlePointerUp = useCallback(() => {
    setDragging(null);
  }, []);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) return;
      const time = getTimeFromX(e.clientX);
      onSeek(time);
    },
    [dragging, getTimeFromX, onSeek]
  );

  const handlePointerLeave = useCallback(() => {
    if (!dragging) setHoverTime(null);
  }, [dragging]);

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft") {
        onSeek(Math.max(0, currentTime - 1));
      } else if (e.key === "ArrowRight") {
        onSeek(Math.min(duration, currentTime + 1));
      } else if (e.key === "[" || e.key === "【") {
        onTrimChange(currentTime, trimEnd);
      } else if (e.key === "]" || e.key === "】") {
        onTrimChange(trimStart, currentTime);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTime, duration, onSeek, onTrimChange, trimStart, trimEnd]);

  if (duration <= 0) return null;

  const progressPct = (currentTime / duration) * 100;
  const trimStartPct = (trimStart / duration) * 100;
  const trimEndPct = (trimEnd / duration) * 100;

  // 生成时间刻度标记
  const tickCount = Math.min(Math.floor(duration / 5), 20);
  const ticks: number[] = [];
  if (tickCount > 0) {
    const interval = duration / tickCount;
    for (let i = 0; i <= tickCount; i++) {
      ticks.push(i * interval);
    }
  }

  return (
    <div className="w-full bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-5 space-y-3">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider flex items-center gap-2">
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          时间轴
        </h3>
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-white/40">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          {(trimStart > 0 || trimEnd < duration) && (
            <span className="text-emerald-400/70 bg-emerald-500/10 px-2 py-0.5 rounded">
              裁切: {formatTime(trimStart)} → {formatTime(trimEnd)}
            </span>
          )}
        </div>
      </div>

      {/* 时间刻度 */}
      <div className="relative h-4 select-none">
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute top-0 text-[10px] text-white/25 font-mono -translate-x-1/2"
            style={{ left: `${(t / duration) * 100}%` }}
          >
            {formatTime(t)}
          </div>
        ))}
      </div>

      {/* 时间轴轨道 */}
      <div
        ref={trackRef}
        className="relative h-12 rounded-lg bg-white/[0.03] border border-white/5 cursor-pointer select-none overflow-hidden"
        onClick={handleTrackClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      >
        {/* 裁切区域外的灰色遮罩 */}
        {trimStartPct > 0 && (
          <div
            className="absolute inset-y-0 left-0 bg-black/50 z-10 pointer-events-none"
            style={{ width: `${trimStartPct}%` }}
          />
        )}
        {trimEndPct < 100 && (
          <div
            className="absolute inset-y-0 right-0 bg-black/50 z-10 pointer-events-none"
            style={{ width: `${100 - trimEndPct}%` }}
          />
        )}

        {/* 裁切区域高亮 */}
        <div
          className="absolute inset-y-0 bg-emerald-500/10 border-y border-emerald-500/20 z-[5] pointer-events-none"
          style={{
            left: `${trimStartPct}%`,
            width: `${trimEndPct - trimStartPct}%`,
          }}
        />

        {/* 裁切起点拖拽手柄 */}
        <div
          className="absolute inset-y-0 w-3 z-30 cursor-col-resize group flex items-center justify-center"
          style={{ left: `calc(${trimStartPct}% - 6px)` }}
          onPointerDown={(e) => handlePointerDown(e, "trimStart")}
        >
          <div
            className={`w-1 h-8 rounded-full transition-all ${
              dragging === "trimStart"
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                : "bg-emerald-500/60 group-hover:bg-emerald-400"
            }`}
          />
        </div>

        {/* 裁切终点拖拽手柄 */}
        <div
          className="absolute inset-y-0 w-3 z-30 cursor-col-resize group flex items-center justify-center"
          style={{ left: `calc(${trimEndPct}% - 6px)` }}
          onPointerDown={(e) => handlePointerDown(e, "trimEnd")}
        >
          <div
            className={`w-1 h-8 rounded-full transition-all ${
              dragging === "trimEnd"
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                : "bg-emerald-500/60 group-hover:bg-emerald-400"
            }`}
          />
        </div>

        {/* 播放进度指针 */}
        <div
          className="absolute inset-y-0 w-4 z-20 cursor-col-resize flex items-center justify-center"
          style={{ left: `calc(${progressPct}% - 8px)` }}
          onPointerDown={(e) => handlePointerDown(e, "playhead")}
        >
          <div className="flex flex-col items-center">
            {/* 三角形头部 */}
            <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-cyan-400" />
            <div
              className={`w-0.5 h-9 ${
                dragging === "playhead"
                  ? "bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.6)]"
                  : "bg-cyan-400/80"
              }`}
            />
          </div>
        </div>

        {/* 悬停时间提示 */}
        {hoverTime !== null && !dragging && (
          <div
            className="absolute -top-7 bg-black/80 text-white/80 text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none z-40 -translate-x-1/2"
            style={{ left: `${hoverX}px` }}
          >
            {formatTime(hoverTime)}
          </div>
        )}

        {/* 处理中进度条 */}
        {isProcessing && (
          <div
            className="absolute bottom-0 left-0 h-0.5 bg-emerald-400/50 z-20 transition-all duration-100"
            style={{ width: `${progressPct}%` }}
          />
        )}
      </div>

      {/* 快捷键提示 + 裁切控制 */}
      <div className="flex items-center justify-between text-[10px] text-white/25">
        <div className="flex items-center gap-3">
          <span>← → 前进/后退 1s</span>
          <span>[ 设置起点</span>
          <span>] 设置终点</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onTrimChange(currentTime, trimEnd)}
            className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-white/50 transition-colors"
            title="设置裁切起点为当前时间"
          >
            设起点
          </button>
          <button
            onClick={() => onTrimChange(trimStart, currentTime)}
            className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-white/50 transition-colors"
            title="设置裁切终点为当前时间"
          >
            设终点
          </button>
          <button
            onClick={() => onTrimChange(0, duration)}
            className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-white/50 transition-colors"
            title="重置裁切区间"
          >
            重置
          </button>
        </div>
      </div>
    </div>
  );
}
