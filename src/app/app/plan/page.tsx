"use client";

import { Suspense } from "react";
import { PlanApp } from "@/components/plan/plan-app";

export default function PlanPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <PlanApp />
    </Suspense>
  );
}
