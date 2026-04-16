"use client";

import React from "react";
import type { TrackerConfig } from "@/lib/tracker-types";

interface ControlPanelProps {
  isReady: boolean;
  isProcessing: boolean;
  statusMessage: string;
  hasVideo: boolean;
  showDebug: boolean;
  config: Partial<TrackerConfig>;
  onToggleDebug: () => void;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onConfigChange: (config: Partial<TrackerConfig>) => void;
}

export default function ControlPanel({
  isReady,
  isProcessing,
  statusMessage,
  hasVideo,
  showDebug,
  config,
  onToggleDebug,
  onPlay,
  onPause,
  onReset,
  onConfigChange,
}: ControlPanelProps) {
  return (
    <div className="w-full max-w-md bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 p-6 space-y-5">
      {/* 状态信息 */}
      <div className="flex items-center gap-3">
        <div
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            isProcessing
              ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]"
              : isReady
              ? "bg-yellow-400"
              : "bg-gray-500"
          }`}
        />
        <span className="text-sm text-white/70 truncate">{statusMessage}</span>
      </div>

      {/* 播放控制 */}
      <div className="flex gap-3">
        <button
          onClick={onPlay}
          disabled={!isReady || !hasVideo || isProcessing}
          className="flex-1 px-4 py-2.5 bg-emerald-500/20 hover:bg-emerald-500/30 disabled:bg-white/5 disabled:text-white/20 text-emerald-300 rounded-xl font-medium text-sm transition-all duration-200 border border-emerald-500/20 disabled:border-white/5"
        >
          ▶ 开始跟踪
        </button>
        <button
          onClick={onPause}
          disabled={!isProcessing}
          className="flex-1 px-4 py-2.5 bg-amber-500/20 hover:bg-amber-500/30 disabled:bg-white/5 disabled:text-white/20 text-amber-300 rounded-xl font-medium text-sm transition-all duration-200 border border-amber-500/20 disabled:border-white/5"
        >
          ⏸ 暂停
        </button>
        <button
          onClick={onReset}
          disabled={!isReady}
          className="px-4 py-2.5 bg-white/5 hover:bg-white/10 disabled:text-white/20 text-white/60 rounded-xl text-sm transition-all duration-200 border border-white/10"
        >
          ↺
        </button>
      </div>

      {/* 调试开关 */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-white/60">调试视图</span>
        <button
          onClick={onToggleDebug}
          className={`relative w-11 h-6 rounded-full transition-all duration-300 ${
            showDebug ? "bg-emerald-500/60" : "bg-white/10"
          }`}
        >
          <div
            className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all duration-300 ${
              showDebug ? "left-6" : "left-1"
            }`}
          />
        </button>
      </div>

      {/* 参数调节 */}
      <div className="space-y-4 pt-2 border-t border-white/5">
        <h3 className="text-sm font-medium text-white/50 uppercase tracking-wider">
          参数调节
        </h3>

        <SliderControl
          label="竖向占比目标"
          value={config.targetVerticalRatio ?? 0.6}
          min={0.3}
          max={0.8}
          step={0.05}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          onChange={(v) => onConfigChange({ targetVerticalRatio: v })}
        />

        <SliderControl
          label="平滑系数"
          value={config.smoothingFactor ?? 0.04}
          min={0.01}
          max={0.15}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => onConfigChange({ smoothingFactor: v })}
          description="越小越平滑，推荐 0.03~0.06"
        />

        <SliderControl
          label="置信度阈值"
          value={config.confidenceThreshold ?? 0.25}
          min={0.1}
          max={0.6}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => onConfigChange({ confidenceThreshold: v })}
        />

        <SliderControl
          label="居中偏移"
          value={config.verticalCenterBias ?? 0.55}
          min={0.3}
          max={0.7}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => onConfigChange({ verticalCenterBias: v })}
          description="< 0.5 偏上 · > 0.5 偏下"
        />

        <SliderControl
          label="面积跳变阈值"
          value={config.areaJumpThreshold ?? 2.5}
          min={1.5}
          max={5}
          step={0.5}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => onConfigChange({ areaJumpThreshold: v })}
          description="帧间面积变化超此值视为遮挡"
        />
      </div>
    </div>
  );
}

// ---------- 滑块子组件 ----------

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  description?: string;
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  description,
}: SliderControlProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm text-white/60">{label}</label>
        <span className="text-sm font-mono text-emerald-300/80">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400
          [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(52,211,153,0.4)]
          [&::-webkit-slider-thumb]:cursor-pointer"
      />
      {description && (
        <div className="text-xs text-white/30">{description}</div>
      )}
    </div>
  );
}
