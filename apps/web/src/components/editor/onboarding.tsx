"use client";

import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
// import { SOCIAL_LINKS } from "@/site/social";
import { useLocalStorage } from "@/services/storage/use-local-storage";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../ui/dialog";

export function Onboarding() {
	const [step, setStep] = useState(0);
	const [hasSeenOnboarding, setHasSeenOnboarding] = useLocalStorage({
		key: "hasSeenOnboarding",
		defaultValue: false,
	});

	const isOpen = !hasSeenOnboarding;

	const handleNext = () => {
		setStep(step + 1);
	};

	const handleClose = () => {
		setHasSeenOnboarding({ value: true });
	};

	const getStepTitle = () => {
		switch (step) {
			case 0:
				return "欢迎使用OpenCut测试版！🎉";
			case 1:
				return "⚠️ 这还是个非常早期的测试版！";
			case 2:
				return "🦋 祝测试愉快！";
			default:
				return "OpenCut新手引导";
		}
	};

	const renderStepContent = () => {
		switch (step) {
			case 0:
				return (
					<div className="space-y-5">
						<div className="space-y-3">
							<Title title="欢迎使用OpenCut测试版！🎉" />
							<Description description="你是最早试用OpenCut的人之一——一款完全开源的CapCut替代品" />
						</div>
						<NextButton onClick={handleNext}>下一步</NextButton>
					</div>
				);
			case 1:
				return (
					<div className="space-y-5">
						<div className="space-y-3">
							<Title title={getStepTitle()} />
							<Description description="要让这款编辑器变得完美，还有很多事要做" />
							<Description description="还缺不少功能，我们正在努力开发！" />
							{/* <Description description="如果你感兴趣，可以查看我们的[路线图](https://opencut.app/roadmap)" /> */}
						</div>
						<NextButton onClick={handleNext}>下一步</NextButton>
					</div>
				);
			case 2:
				return (
					<div className="space-y-5">
						<div className="space-y-3">
							<Title title={getStepTitle()} />
							{/* The step existed only to hand out upstream's Discord
							    invite. Keeping the step but not the invite, so the
							    dialog still ends where people expect it to. */}
							<Description description="有问题或者建议，直接在群里说就行" />
							{/* <Description
								description={`加入我们的[Discord](${SOCIAL_LINKS.discord})，和大家聊天，分享反馈，一起把OpenCut打造成最好用的编辑器`}
							/> */}
						</div>
						<NextButton onClick={handleClose}>完成</NextButton>
					</div>
				);
			default:
				return null;
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogTitle>
					<span className="sr-only">{getStepTitle()}</span>
				</DialogTitle>
				<DialogBody>{renderStepContent()}</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function Title({ title }: { title: string }) {
	return <h2 className="text-lg font-bold md:text-xl">{title}</h2>;
}

function Description({ description }: { description: string }) {
	return (
		<div className="text-muted-foreground">
			<ReactMarkdown
				components={{
					p: ({ children }) => <p className="mb-0">{children}</p>,
					a: ({ href, children }) => (
						<a
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							className="text-foreground hover:text-foreground/80 underline"
						>
							{children}
						</a>
					),
				}}
			>
				{description}
			</ReactMarkdown>
		</div>
	);
}

function NextButton({
	children,
	onClick,
}: {
	children: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<Button onClick={onClick} variant="default" className="w-full">
			{children}
			<ArrowRightIcon className="size-4" />
		</Button>
	);
}
