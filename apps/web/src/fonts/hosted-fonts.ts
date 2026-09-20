/**
 * The families mirrored onto our own CDN, in the order they were curated:
 * every CJK family the atlas offers, then the Latin families worth keeping.
 *
 * Regenerate with scripts/mirror-fonts.py after changing what the bucket
 * holds — a name here that is not on the CDN is worse than a missing one,
 * since the picker will offer it and the stylesheet will 404.
 */
export const HOSTED_FONTS = new Set([
	// CJK
	"Noto Sans SC",
	"Noto Serif SC",
	"Noto Sans TC",
	"Noto Serif TC",
	"Noto Sans HK",
	"Noto Sans JP",
	"Noto Sans KR",
	"LXGW WenKai TC",
	"LXGW WenKai Mono TC",
	"LXGW Marker Gothic",
	"ZCOOL KuaiLe",
	"ZCOOL QingKe HuangYou",
	"ZCOOL XiaoWei",
	"Ma Shan Zheng",
	"Zhi Mang Xing",
	"Liu Jian Mao Cao",
	"Long Cang",

	// Latin
	"Inter",
	"Roboto",
	"Open Sans",
	"Montserrat",
	"Lato",
	"Poppins",
	"Raleway",
	"Oswald",
	"Merriweather",
	"Playfair Display",
	"Nunito",
	"Source Sans 3",
	"Ubuntu",
	"Rubik",
	"Work Sans",
	"Bebas Neue",
	"Anton",
	"Barlow",
	"Karla",
	"Manrope",
	"DM Sans",
	"Space Grotesk",
	"Josefin Sans",
	"Quicksand",
	"Fira Sans",
	"PT Sans",
	"Noto Sans",
	"Noto Serif",
	"Libre Baskerville",
	"Archivo",
	"Cormorant Garamond",
	"Dancing Script",
	"Pacifico",
	"Lobster",
	"Caveat",
]);

/**
 * Whether a family can actually be fetched by this deployment.
 *
 * With no mirror configured every family Google publishes is fair game, which
 * is the upstream behaviour. With one, the mirror is the whole world.
 */
export function isFontAvailable({ family }: { family: string }): boolean {
	if (!process.env.NEXT_PUBLIC_FONT_CSS_BASE) return true;
	return HOSTED_FONTS.has(family);
}
