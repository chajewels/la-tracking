import { motion } from "framer-motion";
import { useLoyaltyData } from "@/components/loyalty/loyaltyData";

const ProfileMemberCard = () => {
  const { member, tiers, transactions } = useLoyaltyData();

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTier = tiers.find((t) => t.name === member.current_tier);
  if (!currentTier) return null;

  const latestTx = transactions?.[0];
  const latestPoints = latestTx?.points ?? 0;
  const latestPointsLabel =
    latestPoints > 0 ? `+${latestPoints}` : `${latestPoints}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{
        opacity: 1,
        y: [0, -3, 0],
      }}
      transition={{
        opacity: { duration: 0.6 },
        y: {
          duration: 4,
          repeat: Infinity,
          ease: "easeInOut",
        },
      }}
      whileHover={{
        y: -8,
        scale: 1.02,
        boxShadow: "0 20px 50px rgba(201,168,76,0.5)",
      }}
      whileTap={{
        scale: 0.98,
      }}
      className="relative overflow-hidden rounded-2xl shadow-elevated cursor-pointer"
      style={{
        background:
          "linear-gradient(135deg, #C9A84C 0%, #E8C96D 50%, #C9A84C 100%)",
        boxShadow: "0 8px 32px rgba(201,168,76,0.35)",
      }}
    >
      {/* Continuous slow shine sweep */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        animate={{ x: ["-100%", "200%"] }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: "linear",
          repeatDelay: 2,
        }}
        style={{
          background:
            "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.3) 50%, transparent 60%)",
          width: "30%",
          mixBlendMode: "overlay",
        }}
      />

      <div className="relative z-10 p-6">
        {/* Tier badge top-right */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <p
              className="text-[10px] tracking-[0.3em] uppercase font-semibold"
              style={{ color: "rgba(0,0,0,0.55)" }}
            >
              Member ID
            </p>
            <p
              className="font-mono text-[15px] font-bold mt-0.5"
              style={{ color: "rgba(0,0,0,0.85)" }}
            >
              {member.member_id}
            </p>
          </div>

          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full"
            style={{ background: "rgba(0,0,0,0.15)" }}
          >
            <span
              className="font-display text-base"
              style={{ color: "rgba(0,0,0,0.75)" }}
            >
              {currentTier.icon}
            </span>
            <span
              className="text-[10px] font-bold tracking-[0.15em] uppercase"
              style={{ color: "rgba(0,0,0,0.75)" }}
            >
              {currentTier.name}
            </span>
          </div>
        </div>

        {/* Big points number */}
        <div className="text-center mb-6">
          <p
            className="text-[10px] tracking-[0.3em] uppercase font-semibold mb-2"
            style={{ color: "rgba(0,0,0,0.55)" }}
          >
            Available Points
          </p>
          <motion.p
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="font-display text-[64px] leading-none font-bold tracking-tight"
            style={{ color: "rgba(0,0,0,0.9)" }}
          >
            {member.available_points.toLocaleString()}
          </motion.p>
        </div>

        {/* Bottom row — Member Since / Lifetime Spend / Latest */}
        <div
          className="grid grid-cols-3 gap-3 pt-4"
          style={{ borderTop: "1px solid rgba(0,0,0,0.18)" }}
        >
          <div className="flex flex-col items-start gap-1">
            <p
              className="text-[9px] tracking-wider uppercase font-semibold"
              style={{ color: "rgba(0,0,0,0.5)" }}
            >
              Member Since
            </p>
            <p
              className="text-[12px] font-semibold"
              style={{ color: "rgba(0,0,0,0.85)" }}
            >
              {member.join_date || "—"}
            </p>
          </div>

          <div className="flex flex-col items-center gap-1">
            <p
              className="text-[9px] tracking-wider uppercase font-semibold"
              style={{ color: "rgba(0,0,0,0.5)" }}
            >
              Lifetime Spend
            </p>
            <p
              className="text-[12px] font-bold"
              style={{ color: "rgba(0,0,0,0.85)" }}
            >
              ¥{member.lifetime_spend_yen.toLocaleString()}
            </p>
          </div>

          <div className="flex flex-col items-end gap-1">
            <p
              className="text-[9px] tracking-wider uppercase font-semibold"
              style={{ color: "rgba(0,0,0,0.5)" }}
            >
              Latest
            </p>
            <p
              className="text-[12px] font-bold"
              style={{
                color:
                  latestPoints > 0
                    ? "rgba(20,80,20,0.85)"
                    : "rgba(120,40,40,0.85)",
              }}
            >
              {latestPointsLabel} pts
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default ProfileMemberCard;
