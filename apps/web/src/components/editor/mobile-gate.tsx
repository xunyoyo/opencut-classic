"use client";

import { useEffect, useState } from "react";
// import Link from "next/link";
import { Button } from "../ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useBranding } from "@/saturn/use-branding";

const STORAGE_KEY = "mobile-acknowledged";

interface MobileGateProps {
	children: React.ReactNode;
}

export function MobileGate({ children }: MobileGateProps) {
	const router = useRouter();
	const [show, setShow] = useState<boolean | null>(null);
	const { siteName } = useBranding();

	useEffect(() => {
		const isMobile = window.innerWidth < 1024;
		const acknowledged = localStorage.getItem(STORAGE_KEY) === "true";
		setShow(isMobile && !acknowledged);
	}, []);

	if (show === null) return null;
	if (!show) return <>{children}</>;

	const handleContinue = () => {
		localStorage.setItem(STORAGE_KEY, "true");
		setShow(false);
	};

	const handleGoBack = () => {
		router.back();
	};

	return (
		<div className="bg-background relative flex h-screen w-screen flex-col overflow-hidden">
			<Button
				variant="text"
				className="absolute top-6 left-6 flex items-center gap-1 text-muted-foreground"
				onClick={handleGoBack}
			>
				<HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
				<span className=" text-sm">返回</span>
			</Button>

			<div className="flex flex-1 flex-col justify-center gap-5 px-7">
				<div className="flex flex-col gap-3">
					<h1 className="text-foreground text-3xl font-bold tracking-tight">
						暂仅支持桌面端
					</h1>
					<p className="text-muted-foreground text-sm leading-relaxed">
						{siteName}剪辑目前还没有针对移动端或iPad优化，界面会错乱，功能也可能出问题，请在桌面端获得完整体验					</p>
				</div>
				<div className="flex items-center gap-3">
					<Button onClick={handleContinue}>仍要查看</Button>
					{/* /roadmap is one of the routes the middleware hides. */}
					{/* <Button variant="ghost" asChild>
						<Link href="/roadmap" className="flex items-center gap-1">
							路线图
							<HugeiconsIcon icon={ArrowRight01Icon} size={14} />
						</Link>
					</Button> */}
				</div>
			</div>
		</div>
	);
}
