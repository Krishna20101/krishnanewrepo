import React from "react";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";

export default function GlobalRouteLoading() {
  return (
    <PleaseWaitScreen
      title="Please wait, loading..."
      subtitle="Please wait, opening the page…"
    />
  );
}
