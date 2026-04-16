"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import type { Viewport, TrackedPerson, TrackerConfig } from "@/lib/tracker-types";

// 引擎实例类型 (不直接 import engine，运行时动态加载)
interface EngineInstance {
  init(): Promise<void>;
  reset(): void;
  processFrame(video: HTMLVideoElement): Promise<{ viewport: Viewport; person: TrackedPerson | null }>;
  processFrameRaw(video: HTMLVideoElement): Promise<{ viewport: Viewport; person: TrackedPerson | null }>;
  dispose(): Promise<void>;
  getConfig(): TrackerConfig;
  updateConfig(partial: Partial<TrackerConfig>): void;
}

export interface UseTrackerReturn {
  isReady: boolean;
  isProcessing: boolean;
  viewport: Viewport | null;
  person: TrackedPerson | null;
  statusMessage: string;
  initEngine: () => Promise<void>;
  startTracking: (video: HTMLVideoElement) => void;
  stopTracking: () => void;
  disposeEngine: () => Promise<void>;
  resetTracking: () => void;
  updateConfig: (config: Partial<TrackerConfig>) => void;
  /** 单帧处理（导出用） */
  processFrameOnce: (video: HTMLVideoElement) => Promise<{ viewport: Viewport; person: TrackedPerson | null }>;
  /** 单帧原始处理（导出用，不含 EMA 平滑） */
  processFrameRaw: (video: HTMLVideoElement) => Promise<{ viewport: Viewport; person: TrackedPerson | null }>;
  /** 引擎是否已初始化 */
  engineReady: boolean;
}

export function useTracker(
  config?: Partial<TrackerConfig>
): UseTrackerReturn {
  const engineRef = useRef<EngineInstance | null>(null);
  const rafRef = useRef<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [person, setPerson] = useState<TrackedPerson | null>(null);
  const [statusMessage, setStatusMessage] = useState("等待初始化...");

  const initEngine = useCallback(async () => {
    if (engineRef.current) return;

    setStatusMessage("正在加载 AI 模型 (MoveNet)...");

    try {
      // 运行时动态加载引擎模块
      const { ClimbingTrackerEngine } = await import("@/lib/tracker-engine");
      const engine = new ClimbingTrackerEngine(config);
      await engine.init();
      engineRef.current = engine;
      setIsReady(true);
      setStatusMessage("模型加载完成，准备就绪");
    } catch (error) {
      console.error("模型加载失败:", error);
      setStatusMessage("模型加载失败，请刷新重试");
    }
  }, [config]);

  const startTracking = useCallback(
    (video: HTMLVideoElement) => {
      if (!engineRef.current || isProcessing) return;

      setIsProcessing(true);
      setStatusMessage("正在跟踪...");

      let lastTime = 0;
      const targetFps = 20;
      const frameInterval = 1000 / targetFps;

      const loop = async (timestamp: number) => {
        if (!engineRef.current) return;

        if (timestamp - lastTime >= frameInterval) {
          lastTime = timestamp;

          if (video.readyState >= 2 && !video.paused) {
            try {
              const result = await engineRef.current.processFrame(video);
              setViewport(result.viewport);
              setPerson(result.person);

              if (result.person?.occluded) {
                setStatusMessage("检测到遮挡，保持跟踪...");
              } else if (result.person) {
                setStatusMessage(
                  `跟踪中 (置信度: ${(result.person.confidence * 100).toFixed(0)}%)`
                );
              } else {
                setStatusMessage("未检测到人体，显示全景");
              }
            } catch {
              // 忽略偶发的帧处理错误
            }
          }
        }

        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);
    },
    [isProcessing]
  );

  const stopTracking = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setIsProcessing(false);
    setStatusMessage("跟踪已暂停");
  }, []);

  const resetTracking = useCallback(() => {
    engineRef.current?.reset();
    setViewport(null);
    setPerson(null);
  }, []);

  const updateConfig = useCallback((partial: Partial<TrackerConfig>) => {
    engineRef.current?.updateConfig(partial);
  }, []);

  const disposeEngine = useCallback(async () => {
    stopTracking();
    if (engineRef.current) {
      await engineRef.current.dispose();
      engineRef.current = null;
    }
    setIsReady(false);
    setViewport(null);
    setPerson(null);
    setStatusMessage("引擎已销毁");
  }, [stopTracking]);

  /** 单帧处理，用于导出和扫描 */
  const processFrameOnce = useCallback(
    async (
      video: HTMLVideoElement
    ): Promise<{ viewport: Viewport; person: TrackedPerson | null }> => {
      if (!engineRef.current) {
        throw new Error("引擎未初始化");
      }
      const result = await engineRef.current.processFrame(video);
      setViewport(result.viewport);
      setPerson(result.person);
      return result;
    },
    []
  );

  /** 单帧原始处理（不含 EMA 平滑），用于导出时的全局扫描 */
  const processFrameRaw = useCallback(
    async (
      video: HTMLVideoElement
    ): Promise<{ viewport: Viewport; person: TrackedPerson | null }> => {
      if (!engineRef.current) {
        throw new Error("引擎未初始化");
      }
      const result = await engineRef.current.processFrameRaw(video);
      setViewport(result.viewport);
      setPerson(result.person);
      return result;
    },
    []
  );

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      engineRef.current?.dispose();
    };
  }, []);

  return {
    isReady,
    isProcessing,
    viewport,
    person,
    statusMessage,
    initEngine,
    startTracking,
    stopTracking,
    disposeEngine,
    resetTracking,
    updateConfig,
    processFrameOnce,
    processFrameRaw,
    engineReady: isReady,
  };
}
