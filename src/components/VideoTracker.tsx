"use client";

import React, { useRef, useEffect, useCallback, useState } from "react";
import type { Viewport, TrackedPerson } from "@/lib/tracker-types";

interface VideoTrackerProps {
  viewport: Viewport | null;
  person: TrackedPerson | null;
  isProcessing: boolean;
  onVideoReady: (video: HTMLVideoElement) => void;
  onVideoEnd?: () => void;
  videoSrc: string | null;
  showDebug: boolean;
  debugCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
}

/**
 * 视频跟踪显示组件
 * 使用 Canvas 渲染裁剪后的画面，同时支持调试叠加层
 */
export default function VideoTracker({
  viewport,
  person,
  isProcessing,
  onVideoReady,
  onVideoEnd,
  videoSrc,
  showDebug,
  debugCanvasRef: externalDebugCanvasRef,
}: VideoTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const internalDebugCanvasRef = useRef<HTMLCanvasElement>(null);
  const debugCanvasRef = externalDebugCanvasRef || internalDebugCanvasRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [videoDimensions, setVideoDimensions] = useState({ w: 0, h: 0 });

  // 视频加载完成时通知父组件
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    setVideoDimensions({ w: video.videoWidth, h: video.videoHeight });
    onVideoReady(video);
  }, [onVideoReady]);

  // 渲染循环：将裁剪后的画面绘制到 Canvas
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const debugCanvas = debugCanvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d");
    const debugCtx = debugCanvas?.getContext("2d");
    if (!ctx) return;

    const render = () => {
      if (video.paused || video.ended) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw === 0 || vh === 0) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      // 设置 canvas 尺寸（基于源视频宽高比和当前视口裁剪比例）
      const vp = viewport || { x: 0, y: 0, width: 1, height: 1 };
      // 视口裁剪后的实际像素宽高比
      const cropPixelW = vp.width * vw;
      const cropPixelH = vp.height * vh;
      const cropAr = cropPixelW / cropPixelH; // 裁剪区域宽高比

      const maxH = Math.min(window.innerHeight * 0.7, 800);
      const maxW = Math.min(window.innerWidth * 0.6, 600);
      let displayH: number;
      let displayW: number;

      // 根据裁剪区域宽高比，在最大尺寸内自适应
      if (cropAr >= 1) {
        // 横版或正方形：以宽度为限
        displayW = Math.min(maxW, maxH * cropAr);
        displayH = displayW / cropAr;
      } else {
        // 竖版：以高度为限
        displayH = Math.min(maxH, maxW / cropAr);
        displayW = displayH * cropAr;
      }

      canvas.width = displayW * window.devicePixelRatio;
      canvas.height = displayH * window.devicePixelRatio;
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      // 计算源裁剪区域（vp 已在上方声明）
      const sx = vp.x * vw;
      const sy = vp.y * vh;
      const sw = vp.width * vw;
      const sh = vp.height * vh;

      // 绘制裁剪后的画面
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, displayW, displayH);

      // 绘制调试信息
      if (showDebug && debugCtx && debugCanvas) {
        const dbgW = 320;
        const dbgH = (dbgW * vh) / vw;
        debugCanvas.width = dbgW;
        debugCanvas.height = dbgH;
        debugCanvas.style.width = `${dbgW}px`;
        debugCanvas.style.height = `${dbgH}px`;

        debugCtx.clearRect(0, 0, dbgW, dbgH);
        debugCtx.drawImage(video, 0, 0, dbgW, dbgH);

        // 绘制视口框
        if (viewport) {
          debugCtx.strokeStyle = "#00ff88";
          debugCtx.lineWidth = 2;
          debugCtx.strokeRect(
            viewport.x * dbgW,
            viewport.y * dbgH,
            viewport.width * dbgW,
            viewport.height * dbgH
          );
        }

        // 绘制人体包围框
        if (person) {
          debugCtx.strokeStyle = person.occluded ? "#ff4444" : "#ffaa00";
          debugCtx.lineWidth = 2;
          debugCtx.setLineDash(person.occluded ? [4, 4] : []);
          debugCtx.strokeRect(
            person.bbox.x * dbgW,
            person.bbox.y * dbgH,
            person.bbox.width * dbgW,
            person.bbox.height * dbgH
          );
          debugCtx.setLineDash([]);

          // 绘制关键点
          debugCtx.fillStyle = person.occluded ? "#ff6666" : "#00ffcc";
          for (const kp of person.keypoints) {
            if ((kp.score ?? 0) > 0.3) {
              debugCtx.beginPath();
              debugCtx.arc(
                (kp.x / vw) * dbgW,
                (kp.y / vh) * dbgH,
                3,
                0,
                Math.PI * 2
              );
              debugCtx.fill();
            }
          }
        }

        // 状态文字
        debugCtx.fillStyle = "#ffffff";
        debugCtx.font = "12px monospace";
        debugCtx.fillText(
          person
            ? `置信度: ${(person.confidence * 100).toFixed(0)}% ${person.occluded ? "[遮挡]" : ""}`
            : "未检测到人体",
          8,
          dbgH - 8
        );
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [viewport, person, showDebug, isProcessing]);

  return (
    <div className="flex flex-col items-center gap-4">
      {/* 隐藏的原始视频元素 */}
      <video
        ref={videoRef}
        src={videoSrc || undefined}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={onVideoEnd}
        crossOrigin="anonymous"
        playsInline
        muted
        className="hidden"
      />

      {/* 主输出画面 */}
      <div ref={containerRef} className="relative">
        <canvas
          ref={canvasRef}
          className="rounded-2xl shadow-2xl border border-white/10"
        />

        {/* 跟踪状态指示器 */}
        {isProcessing && (
          <div className="absolute top-4 left-4 flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                person
                  ? person.occluded
                    ? "bg-yellow-400 animate-pulse"
                    : "bg-green-400"
                  : "bg-red-400 animate-pulse"
              }`}
            />
            <span className="text-xs text-white/80 bg-black/50 px-2 py-1 rounded-lg backdrop-blur-sm">
              {person
                ? person.occluded
                  ? "遮挡保持"
                  : "跟踪中"
                : "搜索中"}
            </span>
          </div>
        )}

        {videoDimensions.w > 0 && (
          <div className="absolute bottom-4 right-4 text-xs text-white/50 bg-black/40 px-2 py-1 rounded-lg backdrop-blur-sm">
            {videoDimensions.w} × {videoDimensions.h}
          </div>
        )}
      </div>

      {/* 调试 canvas（隐藏，由外部调试面板显示） */}
      {showDebug && !externalDebugCanvasRef && (
        <canvas ref={internalDebugCanvasRef} className="hidden" />
      )}
    </div>
  );
}
