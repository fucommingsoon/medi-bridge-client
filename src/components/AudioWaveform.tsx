import { useEffect, useRef, useState } from 'react'

interface AudioWaveformProps {
  analyser: AnalyserNode | null
  isRecording: boolean
  isPaused?: boolean // 是否暂停
  silenceThreshold?: number // 静音阈值，用于显示
  className?: string
}

export function AudioWaveform({ analyser, isRecording, isPaused = false, silenceThreshold = 0.08, className = '' }: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number>()
  const [currentVolume, setCurrentVolume] = useState(0) // 当前音量百分比

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !analyser) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 设置 canvas 尺寸
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw)

      if (!isRecording || isPaused) {
        // 未录音或暂停时显示一条直线
        ctx.fillStyle = isPaused ? 'rgb(254, 252, 232)' : 'rgb(239, 246, 255)'
        ctx.fillRect(0, 0, rect.width, rect.height)
        ctx.beginPath()
        ctx.moveTo(0, rect.height / 2)
        ctx.lineTo(rect.width, rect.height / 2)
        ctx.strokeStyle = isPaused ? 'rgb(234, 179, 8)' : 'rgb(147, 197, 253)'
        ctx.lineWidth = 2
        ctx.stroke()

        // 暂停时显示文字
        if (isPaused) {
          ctx.fillStyle = 'rgb(161, 98, 7)'
          ctx.font = '12px sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('录音已暂停', rect.width / 2, rect.height / 2 - 10)
        }

        setCurrentVolume(0)
        return
      }

      analyser.getByteFrequencyData(dataArray)

      // 清空画布
      ctx.fillStyle = 'rgb(239, 246, 255)'
      ctx.fillRect(0, 0, rect.width, rect.height)

      // 计算平均音量
      let sum = 0
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i]
      }
      const average = sum / bufferLength
      const normalized = average / 255

      // 更新当前音量（用于显示）
      setCurrentVolume(normalized)

      // 根据音量调整颜色
      const isSpeaking = normalized >= silenceThreshold
      const barColor = isSpeaking ? 'rgb(59, 130, 246)' : 'rgb(147, 197, 253)'

      // 绘制频谱条
      const barWidth = (rect.width / bufferLength) * 2.5
      let x = 0

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * rect.height * 0.8

        // 渐变色
        const gradient = ctx.createLinearGradient(0, rect.height - barHeight, 0, rect.height)
        gradient.addColorStop(0, barColor)
        gradient.addColorStop(1, 'rgb(191, 219, 254)')

        ctx.fillStyle = gradient
        ctx.fillRect(x, (rect.height - barHeight) / 2, barWidth, barHeight)

        x += barWidth + 1
      }

      // 绘制阈值线
      const thresholdY = rect.height * (1 - silenceThreshold * 0.8)
      ctx.beginPath()
      ctx.moveTo(0, thresholdY)
      ctx.lineTo(rect.width, thresholdY)
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)'
      ctx.lineWidth = 1
      ctx.setLineDash([5, 5])
      ctx.stroke()
      ctx.setLineDash([])
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [analyser, isRecording, isPaused, silenceThreshold])

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        className={`w-full h-16 rounded-lg ${className}`}
        style={{ background: 'rgb(239, 246, 255)' }}
      />
      {/* 音量指示器 */}
      <div className="absolute bottom-1 right-2 flex items-center gap-2">
        <div className="flex items-center gap-1 bg-white/80 rounded-full px-2 py-1">
          <div className={`w-2 h-2 rounded-full ${currentVolume >= silenceThreshold ? 'bg-blue-500' : 'bg-gray-400'}`}></div>
          <span className="text-xs text-gray-600">{(currentVolume * 100).toFixed(0)}%</span>
        </div>
        <span className="text-xs text-gray-400">阈值: {(silenceThreshold * 100).toFixed(0)}%</span>
      </div>
    </div>
  )
}
