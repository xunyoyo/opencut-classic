"use client";

import Link from "next/link";
// import { RiDiscordFill, RiTwitterXLine } from "react-icons/ri";
// import { FaGithub } from "react-icons/fa6";
import Image from "next/image";
import { resolveLogoUrl, useBranding } from "@/saturn/use-branding";
// import { SOCIAL_LINKS } from "@/site/social";
import { capitalizeFirstLetter } from "@/utils/string";

type Category = "resources" | "company";

interface FooterLink {
	label: string;
	href: string;
}

type CategoryLinks = Record<Category, FooterLink[]>;

// Everything commented out here either promotes the upstream project or is a
// route the middleware now hides, so linking to it would only produce a 404.
// An emptied category is skipped below rather than rendering a bare heading.
const links: CategoryLinks = {
	resources: [
		// { label: "Roadmap", href: "/roadmap" },
		// { label: "Changelog", href: "/changelog" },
		// { label: "Blog", href: "/blog" },
		// { label: "Privacy", href: "/privacy" },
		// { label: "Terms of use", href: "/terms" },
	],
	company: [
		// { label: "Contributors", href: "/contributors" },
		// { label: "Sponsors", href: "/sponsors" },
		// { label: "Brand", href: "/brand" },
		// { label: "About", href: `${SOCIAL_LINKS.github}/blob/main/README.md` },
	],
};

export function Footer() {
	const { siteName, logoUrl: brandLogoUrl, copyrightText, useTextLogo } =
		useBranding();
	const logoUrl = resolveLogoUrl({ logoUrl: brandLogoUrl });

	return (
		<footer className="bg-background border-t">
			<div className="mx-auto max-w-5xl px-8 py-10">
				<div className="mb-8 grid grid-cols-1 gap-12 md:grid-cols-2">
					{/* Brand Section */}
					<div className="max-w-sm md:col-span-1">
						<div className="mb-4 flex items-center justify-start gap-2">
							{useTextLogo ? null : (
								<Image
									src={logoUrl}
									alt={siteName}
									width={24}
									height={24}
									className="invert dark:invert-0"
								/>
							)}
							<span className="text-lg font-bold">{siteName}</span>
						</div>
						<p className="text-muted-foreground mb-5 text-sm md:text-left">
							把成片拖进来做精剪。
						</p>
						{/* Upstream's GitHub, X and Discord. */}
						{/* <div className="flex justify-start gap-3">
							<Link
								href={SOCIAL_LINKS.github}
								className="text-muted-foreground hover:text-foreground transition-colors"
								target="_blank"
								rel="noopener noreferrer"
							>
								<FaGithub className="size-5" />
							</Link>
							<Link
								href={SOCIAL_LINKS.x}
								className="text-muted-foreground hover:text-foreground transition-colors"
								target="_blank"
								rel="noopener noreferrer"
							>
								<RiTwitterXLine className="size-5" />
							</Link>
							<Link
								href={SOCIAL_LINKS.discord}
								className="text-muted-foreground hover:text-foreground transition-colors"
								target="_blank"
								rel="noopener noreferrer"
							>
								<RiDiscordFill className="size-5" />
							</Link>
						</div> */}
					</div>

					<div className="flex items-start justify-start gap-12 py-2">
						{(Object.keys(links) as Category[])
							.filter((category) => links[category].length > 0)
							.map((category) => (
								<div key={category} className="flex flex-col gap-2">
									<h3 className="text-foreground font-semibold">
										{capitalizeFirstLetter({ string: category })}
									</h3>
									<ul className="space-y-2 text-sm">
										{links[category].map((link) => (
											<li key={link.href}>
												<Link
													href={link.href}
													className="text-muted-foreground hover:text-foreground transition-colors"
													target={
														link.href.startsWith("http") ? "_blank" : undefined
													}
													rel={
														link.href.startsWith("http")
															? "noopener noreferrer"
															: undefined
													}
												>
													{link.label}
												</Link>
											</li>
										))}
									</ul>
								</div>
							))}
					</div>
				</div>

				{/* Bottom Section */}
				<div className="flex flex-col items-start justify-between gap-4 pt-2 md:flex-row">
					<div className="text-muted-foreground flex items-center gap-4 text-sm">
						<span>{copyrightText}</span>
					</div>
				</div>
			</div>
		</footer>
	);
}
