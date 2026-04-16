"use client";

import React, { useRef, useCallback } from "react";

interface VideoUploaderProps {
  onVideoSelected: (url: string, fileName: string) => void;
  hasVideo: boolean;
  fileName: string;
}

export default function VideoUploader({
  onVideoSelected,
  hasVideo,
  fileName,
}: VideoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("video/")) {
        alert("请选择视频文件");
        return;
      }
      const url = URL.createObjectURL(file);
      onVideoSelected(url, file.name);
    },
    [onVideoSelected]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
      if (dropRef.current) {
        dropRef.current.classList.remove("border-emerald-400", "bg-emerald-500/10");
      }
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (dropRef.current) {
      dropRef.current.classList.add("border-emerald-400", "bg-emerald-500/10");
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (dropRef.current) {
      dropRef.current.classList.remove("border-emerald-400", "bg-emerald-500/10");
    }
  }, []);

  return (
    <div
      ref={dropRef}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => inputRef.current?.click()}
      className={`relative cursor-pointer border-2 border-dashed rounded-2xl p-8 transition-all duration-300 text-center group
        ${
          hasVideo
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.04]"
        }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
        className="hidden"
      />

      <div className="flex flex-col items-center gap-3">
        <div
          className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-300 ${
            hasVideo
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-white/5 text-white/30 group-hover:bg-white/10 group-hover:text-white/50"
          }`}
        >
          {hasVideo ? (
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
          )}
        </div>

        {hasVideo ? (
          <>
            <div className="text-emerald-300 font-medium">{fileName}</div>
            <div className="text-sm text-white/40">点击或拖拽更换视频</div>
          </>
        ) : (
          <>
            <div className="text-white/60 font-medium">
              拖拽攀岩视频到这里
            </div>
            <div className="text-sm text-white/30">
              或点击选择文件 · 支持 MP4 / WebM / MOV
            </div>
          </>
        )}
      </div>
    </div>
  );
}
