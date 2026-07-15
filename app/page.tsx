import dynamic from "next/dynamic";

const AlpineFlowLab = dynamic(
  () => import("@/components/AlpineFlowLab").then((mod) => ({ default: mod.AlpineFlowLab })),
  { ssr: false },
);

export default function Home() {
  return <AlpineFlowLab />;
}

