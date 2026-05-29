import * as React from 'react';
import { Building2, Smartphone, MapPin, Zap, Copy, Check, Banknote, Truck } from 'lucide-react';

// Portal palette — must match src/pages/CustomerPortal.tsx
const P = {
  bg: '#0A0A0A', s: '#111111', s2: '#1A1A1A', br: '#2A2200',
  gp: '#C9A84C', gl: '#E8C96D', gd: '#8B6914',
  tp: '#F5F0E8', ts: '#9A8F7E',
  gr: 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
} as const;
const CG = "'Cormorant Garamond',Georgia,serif";

export interface ChaPaymentMethod {
  id: string;
  name: string;
  group: 'PH' | 'JP';
  icon: React.ReactNode;
  isFast?: boolean;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  branchName?: string;
  bankCode?: string;
  branchCode?: string;
  accountType?: string;
  recipientAddress?: string;
  phone?: string;
  email?: string;
  extraNumbers?: Array<{ number: string; label: string }>;
  location?: string;
  payId?: string;
}

export const CHA_PAYMENT_METHODS: ChaPaymentMethod[] = [
  // Philippines
  {
    id: 'bpi', name: 'BPI', group: 'PH',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Bank of the Philippine Islands (BPI)',
    accountNumber: '8899-2755-95',
    accountName: 'CHAJEWELSJAPAN JEWELRY AND ACCESSORIES SHOP',
    branchName: 'Rosario Batangas',
    accountType: 'Peso Savings',
    recipientAddress: '296 Calicanto San Juan Batangas 4226',
    phone: '0916-723-5528',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'metrobank', name: 'Metrobank', group: 'PH',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Metrobank',
    accountNumber: '397-7-397-55124-1',
    accountName: 'CHAJEWELSJAPAN JEWELRY AND ACCESSORIES SHOP',
    branchName: 'Rosario Batangas',
    accountType: 'Peso Savings',
    recipientAddress: '296 Calicanto San Juan Batangas 4226',
    phone: '0916-723-5528',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'bdo', name: 'BDO', group: 'PH',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'BDO Unibank',
    accountNumber: '004970387187',
    accountName: 'CHAJEWELSJAPAN JEWELRY AND ACCESSORIES SHOP',
    branchName: 'San Juan Batangas',
    accountType: 'Peso Savings',
    recipientAddress: 'Calicanto San Juan Batangas',
    phone: '0952-446-8539',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'gcash', name: 'GCash', group: 'PH',
    icon: <Smartphone className="h-5 w-5" />,
    isFast: true,
    extraNumbers: [
      { number: '0916-723-5528', label: 'April Largo' },
      { number: '0915-7511-043', label: 'Cynthia Largo' },
    ],
  },
  {
    id: 'cash-pickup', name: 'Cash Pickup', group: 'PH',
    icon: <MapPin className="h-5 w-5" />,
    accountName: 'Cesar Magsino',
    location: 'San Juan Batangas',
    phone: '0906 032 2808',
  },
  {
    id: 'cash-payment', name: 'Cash Payment', group: 'PH',
    icon: <Banknote className="h-5 w-5" />,
  },
  {
    id: 'cash-on-delivery', name: 'Cash on Delivery', group: 'PH',
    icon: <Truck className="h-5 w-5" />,
  },
  // Japan
  {
    id: 'rakuten', name: 'Rakuten Bank', group: 'JP',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Rakuten Bank',
    branchName: '第四営業支店',
    bankCode: '0036',
    branchCode: '254',
    accountNumber: '7555832',
    accountType: 'Ordinary (Futsuu)',
    accountName: 'チャ ジュエルズ カブシキガイシャ',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'sumitomo', name: 'Sumitomo Bank', group: 'JP',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Sumitomo Bank',
    branchName: '新小岩',
    bankCode: '0009',
    branchCode: '232',
    accountNumber: '7756718',
    accountType: 'Ordinary (Futsuu)',
    accountName: 'ﾁﾔ- ｼﾞﾕｴﾙｽ ﾗﾙｺﾞ ｼﾝﾃｲｱ ﾈﾗ',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'paypay', name: 'PayPay', group: 'JP',
    icon: <Smartphone className="h-5 w-5" />,
    isFast: true,
    payId: 'chajewelsjapan',
    phone: '070-8307-3318',
  },
];

export function copyToClipboard(text: string, label: string, setCopied: (v: string | null) => void) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  });
}

export function buildFullDetails(m: ChaPaymentMethod): string {
  const lines: string[] = [m.name];
  if (m.bankName) lines.push(`Bank: ${m.bankName}`);
  if (m.branchName) lines.push(`Branch: ${m.branchName}`);
  if (m.bankCode) lines.push(`Bank Code: ${m.bankCode}`);
  if (m.branchCode) lines.push(`Branch Code: ${m.branchCode}`);
  if (m.accountNumber) lines.push(`Account #: ${m.accountNumber}`);
  if (m.accountType) lines.push(`Type: ${m.accountType}`);
  if (m.accountName) lines.push(`Name: ${m.accountName}`);
  if (m.recipientAddress) lines.push(`Address: ${m.recipientAddress}`);
  if (m.phone) lines.push(`Phone: ${m.phone}`);
  if (m.email) lines.push(`Email: ${m.email}`);
  if (m.payId) lines.push(`PayPay ID: ${m.payId}`);
  if (m.location) lines.push(`Location: ${m.location}`);
  if (m.extraNumbers) m.extraNumbers.forEach(n => lines.push(`${n.label}: ${n.number}`));
  return lines.join('\n');
}

/* ─── Payment Method Detail Card ─── */
export function PaymentMethodCard({ method, onSelect, copiedField, setCopied }: {
  method: ChaPaymentMethod;
  onSelect: () => void;
  copiedField: string | null;
  setCopied: (v: string | null) => void;
}) {
  const CopyBtn = ({ text, label }: { text: string; label: string }) => (
    <button
      onClick={(e) => { e.stopPropagation(); copyToClipboard(text, label, setCopied); }}
      className="inline-flex items-center gap-1 transition-colors"
      style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:500,color:copiedField===label?'#5CB86A':P.gp,border:'none',background:'transparent',cursor:'pointer'}}
    >
      {copiedField === label ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copiedField === label ? 'Copied!' : 'Copy'}
    </button>
  );

  return (
    <div style={{background:P.s,border:`1px solid ${P.br}`,borderTop:`2px solid ${P.gp}`,borderRadius:'2px',overflow:'hidden'}}>
      {/* Header */}
      <div className="flex items-center gap-3 p-4">
        <div style={{width:'36px',height:'36px',display:'flex',alignItems:'center',justifyContent:'center',background:`rgba(201,168,76,0.1)`,color:P.gp,flexShrink:0}}>
          {method.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p style={{fontFamily:CG,fontSize:'16px',fontWeight:600,color:P.tp}}>{method.name}</p>
            {method.isFast && (
              <span style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:600,letterSpacing:'0.1em',color:'#5CB86A',border:'1px solid rgba(92,184,106,0.3)',padding:'1px 6px',borderRadius:'2px',display:'inline-flex',alignItems:'center',gap:'3px'}}>
                <Zap className="h-2.5 w-2.5" /> Fast
              </span>
            )}
          </div>
          {method.bankName && <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{method.bankName}</p>}
        </div>
      </div>

      {/* Details */}
      <div style={{padding:'0 1rem 0.75rem',borderTop:`1px solid ${P.br}`}}>
        {[
          method.accountNumber && { lbl:'Account #', val:method.accountNumber, copy:`${method.id}-acct`, mono:true },
          method.accountName   && { lbl:'Name',      val:method.accountName,   copy:`${method.id}-name`, mono:false },
          method.branchName    && { lbl:'Branch',    val:method.branchName },
          method.bankCode      && { lbl:'Bank Code', val:method.bankCode,  mono:true },
          method.branchCode    && { lbl:'Branch Code',val:method.branchCode,mono:true },
          (method.accountType && method.bankName) && { lbl:'Type', val:method.accountType },
          method.payId         && { lbl:'PayPay ID', val:method.payId,    copy:`${method.id}-payid`, mono:true },
          method.location      && { lbl:'Location',  val:method.location },
          method.phone         && { lbl:'Phone',     val:method.phone,    copy:`${method.id}-phone` },
          method.email         && { lbl:'Email',     val:method.email },
          method.recipientAddress && { lbl:'Address', val:method.recipientAddress },
        ].filter(Boolean).map((row: any, i) => (
          <div key={i} className="flex items-center justify-between py-2" style={{borderBottom:`1px solid ${P.s2}`}}>
            <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,flexShrink:0}}>{row.lbl}:</span>
            <span className="flex items-center gap-2 min-w-0 ml-2">
              <span style={{fontFamily:row.mono?'monospace':"Inter,sans-serif",fontSize:'12px',color:P.tp,textAlign:'right',minWidth:0,overflow:'hidden',textOverflow:'ellipsis'}}>{row.val}</span>
              {row.copy && <CopyBtn text={row.val} label={row.copy} />}
            </span>
          </div>
        ))}
        {method.extraNumbers && method.extraNumbers.map((n, i) => (
          <div key={i} className="flex items-center justify-between py-2" style={{borderBottom:`1px solid ${P.s2}`}}>
            <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{n.label}:</span>
            <span className="flex items-center gap-2">
              <span style={{fontFamily:'monospace',fontSize:'12px',color:P.tp}}>{n.number}</span>
              <CopyBtn text={n.number} label={`${method.id}-num-${i}`} />
            </span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 p-3" style={{borderTop:`1px solid ${P.br}`}}>
        <button
          className="flex-1 flex items-center justify-center gap-1.5 h-9 transition-opacity hover:opacity-80"
          style={{background:'transparent',border:`1px solid ${P.br}`,borderRadius:'2px',color:P.ts,fontFamily:"Inter,sans-serif",fontSize:'11px',letterSpacing:'0.08em',cursor:'pointer'}}
          onClick={(e) => { e.stopPropagation(); copyToClipboard(buildFullDetails(method), `${method.id}-full`, setCopied); }}
        >
          <Copy className="h-3 w-3" />
          {copiedField === `${method.id}-full` ? 'Copied!' : 'Copy All'}
        </button>
        <button
          className="flex-1 flex items-center justify-center gap-1.5 h-9 transition-opacity hover:opacity-90"
          style={{background:P.gr,border:'none',borderRadius:'2px',color:P.bg,fontFamily:"Inter,sans-serif",fontSize:'11px',fontWeight:600,letterSpacing:'0.12em',textTransform:'uppercase' as const,cursor:'pointer'}}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
        >
          Select &amp; Pay
        </button>
      </div>
    </div>
  );
}
