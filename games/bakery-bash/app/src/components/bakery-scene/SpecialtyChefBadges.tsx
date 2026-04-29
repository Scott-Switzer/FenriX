import { SCENE } from './scene-geometry'

/**
 * K-07 (2026-04-29) — render the team's specialty chefs in the simulation
 * kitchen as portrait badges along the back wall.
 *
 * Why portraits, not pixel sprites? The existing sous-chef sprites are
 * 24×40 pixel grids hand-drawn in `chef-bakery.ts` etc. — adding 4
 * unique nationalities × 2 genders = 8 new pixel sprites just for
 * specialty chefs is a much bigger sprite-art ask than the spec
 * justifies. Instead we re-use the 4 nationality SVG portraits already
 * shipped at `/assets/chefs/{nationality}-{gender}.svg` (used on the
 * Auction page), positioned as small framed cameos on the wall-mounts
 * band above the team sign so they're clearly visible without
 * overlapping the sous-chef silhouettes that work the counter.
 *
 * Position layout:
 *   - Cameos sit in `SCENE.zones.wallMounts` (y=0..30) on the LEFT half
 *     of the wall, leaving the team sign (x=180..300) and door area
 *     (x=420..456) untouched.
 *   - Each cameo is 22×22 with a 1px caramel border — small enough to
 *     fit 3 in a row at x=8/34/60 with breathing room.
 */

export interface SpecialtyChefBadge {
  /** Stable id from the player doc (`players/{uid}.specialtyChefs[].id`). */
  id: string
  nationality: 'american' | 'french' | 'italian' | 'japanese'
  /** Gender as stored in the player doc ('m' | 'f'). */
  gender: 'm' | 'f'
  /** Display name (e.g. "Italian Chef"). Renders as the title attr only. */
  name: string
}

interface Props {
  chefs: SpecialtyChefBadge[]
}

const BADGE_SIZE = 22
const BADGE_GAP = 4
const BADGE_LEFT = 8
const BADGE_TOP = 4

const MAX_VISIBLE = 3

const NATIONALITY_LABEL: Record<SpecialtyChefBadge['nationality'], string> = {
  american: 'American',
  french: 'French',
  italian: 'Italian',
  japanese: 'Japanese',
}

export function SpecialtyChefBadges({ chefs }: Props) {
  if (chefs.length === 0) return null
  // Cap at MAX_VISIBLE per the team's specialtyChefCap. Beyond that the
  // wall-mounts band runs out of room before the team sign.
  const visible = chefs.slice(0, MAX_VISIBLE)
  return (
    <div
      aria-hidden
      data-testid="specialty-chef-badges"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        // Keep the badges INSIDE the scene-coordinate space so the parent
        // (PixelBakeryScene)'s scaling carries them along with the rest
        // of the scene — no visual drift on a 1.5× zoom.
        // SCENE.width/height are referenced for documentation only here.
        width: SCENE.width,
        height: SCENE.height,
      }}
    >
      {visible.map((chef, i) => {
        const left = BADGE_LEFT + i * (BADGE_SIZE + BADGE_GAP)
        const portrait = `/assets/chefs/${chef.nationality}-${chef.gender}.svg`
        const label = `${NATIONALITY_LABEL[chef.nationality]} chef — ${chef.name}`
        return (
          <div
            key={chef.id}
            data-testid={`specialty-chef-${chef.id}`}
            title={label}
            style={{
              position: 'absolute',
              left: `${left}px`,
              top: `${BADGE_TOP}px`,
              width: `${BADGE_SIZE}px`,
              height: `${BADGE_SIZE}px`,
              borderRadius: '50%',
              border: '1px solid #c08842',
              background: '#fffaf2',
              overflow: 'hidden',
              boxShadow: '0 1px 0 rgba(0,0,0,0.3)',
            }}
          >
            <img
              src={portrait}
              alt=""
              width={BADGE_SIZE}
              height={BADGE_SIZE}
              style={{ display: 'block', width: '100%', height: '100%' }}
              onError={(e) => {
                // Defensive: hide the broken-image icon if the asset is
                // missing for some reason. The wall slot stays empty.
                ;(e.currentTarget as HTMLImageElement).style.display = 'none'
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
