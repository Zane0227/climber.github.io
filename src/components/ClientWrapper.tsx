"use client";

import dynamic from "next/dynamic";

const ClimbingApp = dynamic(() => import("@/components/ClimbingApp"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="w-12 h-12 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin mx-auto" />
        <p className="text-white/50 text-sm">加载 AI 模型中...</p>
      </div>
    </div>
  ),
});

export default function ClientWrapper() {
  return <ClimbingApp />;
}
