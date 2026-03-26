import { Construction } from 'lucide-react'

export default function ComingSoonPage({ title = 'Coming Soon', description }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-100 flex items-center justify-center mb-4">
        <Construction size={28} className="text-surface-400" />
      </div>
      <h2 className="text-xl font-bold text-surface-900 mb-2">{title}</h2>
      <p className="text-sm text-surface-500 max-w-md">
        {description || 'This page is under construction. Check back soon!'}
      </p>
    </div>
  )
}
