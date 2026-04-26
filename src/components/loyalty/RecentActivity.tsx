import { motion } from "framer-motion";
import { Star, Gem } from "lucide-react";
import { useLoyaltyData } from "@/components/loyalty/loyaltyData";

interface RecentActivityProps {
  onViewAll?: () => void;
}

const RecentActivity = ({ onViewAll }: RecentActivityProps) => {
  const { transactions } = useLoyaltyData();
  if (!transactions) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-lg font-semibold text-foreground">
          Recent Activity
        </h3>
        <button
          onClick={onViewAll}
          className="text-[13px] text-primary font-body font-semibold tracking-wide"
        >
          View All
        </button>
      </div>
      <div className="space-y-2">
        {transactions.slice(0, 3).map((tx, i) => (
          <motion.div
            key={tx.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 * i + 0.8 }}
            className="bg-card rounded-xl p-3.5 shadow-card border-gold-accent flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center ${
                  tx.type === "earned"
                    ? "bg-primary/10"
                    : "bg-destructive/10"
                }`}
              >
                {tx.type === "earned" ? (
                  <Star size={14} className="text-primary" strokeWidth={1.8} />
                ) : (
                  <Gem
                    size={14}
                    className="text-destructive"
                    strokeWidth={1.8}
                  />
                )}
              </div>
              <div>
                <p className="text-[13px] font-body font-medium text-foreground">
                  {tx.description}
                </p>
                <p className="text-[12px] text-muted-foreground font-body mt-0.5">
                  {tx.date}
                </p>
              </div>
            </div>
            <span
              className={`text-sm font-body font-semibold ${
                tx.points > 0 ? "text-primary" : "text-destructive/70"
              }`}
            >
              {tx.points > 0 ? "+" : ""}
              {tx.points}
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
};

export default RecentActivity;
