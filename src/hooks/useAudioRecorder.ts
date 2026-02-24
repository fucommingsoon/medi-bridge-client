import { useRef, useCallback } from 'react'

interface AudioRecorderOptions {
  onDataAvailable: (blob: Blob) => void
  onError?: (error: Error) => void
  onSpeechStart?: () => void
  onSpeechEnd?: (duration: number) => void
  onSilenceSubmit?: (blob: Blob, blobSize: number, duration: number) => void
  silenceThreshold?: number
  silenceDuration?: number
  minSpeechDuration?: number
}

interface AudioRecorderReturn {
  startRecording: () => Promise<boolean>
  stopRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  isRecording: boolean
  isPaused: boolean
  analyser: AnalyserNode | null
}

export function useAudioRecorder({
  onDataAvailable,
  onError,
  onSpeechStart,
  onSpeechEnd,
  onSilenceSubmit,
  silenceThreshold = 0.15,
  silenceDuration = 2000,
  minSpeechDuration = 800,
}: AudioRecorderOptions): AudioRecorderReturn {
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

  // 当前片段的 MediaRecorder 和数据块
  const currentMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const currentChunksRef = useRef<Blob[]>([])

  // 状态追踪
  const isRecordingRef = useRef(false)
  const isPausedRef = useRef(false)
  const isSpeechDetectedRef = useRef(false)
  const speechStartTimeRef = useRef<number>(0)
  const silenceStartTimeRef = useRef<number>(0)
  const checkSilenceIntervalRef = useRef<number>()

  // 连续静音/有声计数（用于更稳定的边界检测）
  const consecutiveSilentFramesRef = useRef<number>(0)
  const consecutiveSpeechFramesRef = useRef<number>(0)
  const MIN_SPEECH_FRAMES = 3 // 至少3帧（300ms）连续有声才算说话开始
  const MIN_SILENCE_FRAMES = 20 // 至少20帧（2秒）连续静音才算说话结束

  // 分析音频数据判断是否为静音
  const isSilent = useCallback((analyser: AnalyserNode): boolean => {
    const dataArray = new Uint8Array(analyser.fftSize)
    analyser.getByteFrequencyData(dataArray)

    // 计算平均音量，忽略低频部分（主要是噪音）
    let sum = 0
    let count = 0
    for (let i = 4; i < dataArray.length; i++) { // 从索引4开始，忽略低频
      sum += dataArray[i]
      count++
    }
    const average = sum / count
    const normalized = average / 255

    if (import.meta.env.DEV) {
      const now = Date.now()
      if (!window['__lastVolumeLog'] || now - window['__lastVolumeLog'] > 1000) {
        const speechState = consecutiveSpeechFramesRef.current >= MIN_SPEECH_FRAMES ? '▶ 说话' : '静音'
        console.log(`[音量] ${speechState} ${(normalized * 100).toFixed(1)}% (阈值: ${(silenceThreshold * 100).toFixed(1)}%, 连续帧: ${consecutiveSpeechFramesRef.current})`)
        window['__lastVolumeLog'] = now
      }
    }

    return normalized < silenceThreshold
  }, [silenceThreshold, MIN_SPEECH_FRAMES])

  // 创建新的 MediaRecorder 用于当前片段
  const createMediaRecorder = useCallback((stream: MediaStream): MediaRecorder => {
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
    })

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        currentChunksRef.current.push(event.data)
      }
    }

    return mediaRecorder
  }, [])

  // 启动当前片段的录音
  const startCurrentSegment = useCallback(() => {
    if (!streamRef.current) return

    currentMediaRecorderRef.current = createMediaRecorder(streamRef.current)
    currentChunksRef.current = []
    currentMediaRecorderRef.current.start(100)

    console.log('[录音] 新片段录音已启动')
  }, [createMediaRecorder])

  // 停止并提交当前片段
  const stopCurrentSegment = useCallback(() => {
    const mediaRecorder = currentMediaRecorderRef.current
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      return null
    }

    return new Promise<Blob | null>((resolve) => {
      const originalOnStop = mediaRecorder.onstop
      mediaRecorder.onstop = () => {
        const chunks = currentChunksRef.current
        if (chunks.length > 0) {
          const blob = new Blob(chunks, { type: 'audio/webm;codecs=opus' })
          console.log('[录音] 片段 Blob 创建成功:', {
            chunks: chunks.length,
            size: blob.size,
          })
          resolve(blob)
        } else {
          resolve(null)
        }
        // 恢复原始的 onstop
        mediaRecorder.onstop = originalOnStop
      }

      mediaRecorder.stop()
    })
  }, [])

  // 检查静音状态并提交语音片段
  const checkSilence = useCallback(() => {
    const analyser = analyserRef.current

    if (!analyser || !isRecordingRef.current || isPausedRef.current) {
      return
    }

    const isCurrentlySilent = isSilent(analyser)
    const now = Date.now()

    if (isCurrentlySilent) {
      consecutiveSilentFramesRef.current++
      consecutiveSpeechFramesRef.current = 0
    } else {
      consecutiveSpeechFramesRef.current++
      consecutiveSilentFramesRef.current = 0
    }

    // 检测到说话开始：需要连续多帧都有声音
    if (!isSpeechDetectedRef.current && consecutiveSpeechFramesRef.current >= MIN_SPEECH_FRAMES) {
      isSpeechDetectedRef.current = true
      speechStartTimeRef.current = now - (consecutiveSpeechFramesRef.current * 100) // 回推开始时间
      console.log('[录音] ▶ 检测到开始说话')
      onSpeechStart?.()
    }

    // 检测到说话结束：需要连续多帧都是静音
    if (isSpeechDetectedRef.current && consecutiveSilentFramesRef.current >= MIN_SILENCE_FRAMES) {
      const speechDurationMs = now - speechStartTimeRef.current
      const silenceDurationMs = consecutiveSilentFramesRef.current * 100

      console.log(`[录音] 连续静音 ${consecutiveSilentFramesRef.current} 帧 (${silenceDurationMs}ms)，说话时长 ${speechDurationMs}ms`)

      if (speechDurationMs >= minSpeechDuration) {
        // 停止当前片段并获取 blob
        stopCurrentSegment().then((blob) => {
          if (blob) {
            const blobSize = blob.size / 1024
            console.log(`[录音] ✓ 提交语音片段: ${blobSize.toFixed(2)}KB, 时长: ${speechDurationMs}ms`)

            onSpeechEnd?.(speechDurationMs)
            onSilenceSubmit?.(blob, blobSize, speechDurationMs)

            // 立即发送到后端（异步，不阻塞）
            console.log('[录音] → 立即发送到后端...')
            onDataAvailable(blob)

            // 重置状态
            isSpeechDetectedRef.current = false
            speechStartTimeRef.current = 0
            consecutiveSilentFramesRef.current = 0

            // 启动新片段
            startCurrentSegment()
          }
        })
      } else {
        console.log(`[录音] ✗ 语音片段太短 (${speechDurationMs}ms < ${minSpeechDuration}ms)，已丢弃`)
        isSpeechDetectedRef.current = false
        speechStartTimeRef.current = 0
        consecutiveSilentFramesRef.current = 0
      }
    }
  }, [isSilent, MIN_SPEECH_FRAMES, MIN_SILENCE_FRAMES, minSpeechDuration, startCurrentSegment, stopCurrentSegment, onDataAvailable, onSpeechStart, onSpeechEnd, onSilenceSubmit])

  // 开始录音
  const startRecording = useCallback(async () => {
    try {
      console.log('[录音] 正在请求麦克风权限...')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      console.log('[录音] ✓ 麦克风权限获取成功')
      streamRef.current = stream

      const audioContext = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioContext

      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyserRef.current = analyser

      const source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)
      sourceRef.current = source

      isRecordingRef.current = true
      isSpeechDetectedRef.current = false
      speechStartTimeRef.current = 0
      silenceStartTimeRef.current = 0
      consecutiveSilentFramesRef.current = 0
      consecutiveSpeechFramesRef.current = 0

      // 启动第一个片段
      startCurrentSegment()

      // 启动静音检测定时器
      checkSilenceIntervalRef.current = window.setInterval(checkSilence, 100)

      console.log('[录音] ✓ 录音已启动')
      return true
    } catch (error) {
      console.error('[录音] ✗ 启动失败:', error)
      onError?.(error as Error)
      return false
    }
  }, [checkSilence, startCurrentSegment, onError])

  const pauseRecording = useCallback(() => {
    if (isPausedRef.current) return
    isPausedRef.current = true

    // 暂停当前片段
    if (currentMediaRecorderRef.current && currentMediaRecorderRef.current.state === 'recording') {
      currentMediaRecorderRef.current.pause()
    }

    console.log('[录音] ⏸ 录音已暂停')
  }, [])

  const resumeRecording = useCallback(() => {
    if (!isPausedRef.current) return
    isPausedRef.current = false

    // 恢复当前片段
    if (currentMediaRecorderRef.current && currentMediaRecorderRef.current.state === 'paused') {
      currentMediaRecorderRef.current.resume()
    }

    console.log('[录音] ▶ 录音已恢复')
  }, [])

  const stopRecording = useCallback(async () => {
    console.log('[录音] 正在停止录音...')

    if (checkSilenceIntervalRef.current) {
      clearInterval(checkSilenceIntervalRef.current)
    }

    isPausedRef.current = false
    isRecordingRef.current = false

    // 停止当前片段并提交
    if (isSpeechDetectedRef.current && consecutiveSpeechFramesRef.current >= MIN_SPEECH_FRAMES) {
      const now = Date.now()
      const speechDurationMs = now - speechStartTimeRef.current

      if (speechDurationMs >= minSpeechDuration) {
        const blob = await stopCurrentSegment()
        if (blob) {
          const blobSize = blob.size / 1024
          console.log(`[录音] ✓ 提交最后一段语音: ${blobSize.toFixed(2)}KB, 时长: ${speechDurationMs}ms`)

          onSpeechEnd?.(speechDurationMs)
          onSilenceSubmit?.(blob, blobSize, speechDurationMs)
          onDataAvailable(blob)
        }
      }
    }

    // 清理
    if (currentMediaRecorderRef.current && currentMediaRecorderRef.current.state !== 'inactive') {
      currentMediaRecorderRef.current.stop()
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect()
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close()
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    currentMediaRecorderRef.current = null
    audioContextRef.current = null
    analyserRef.current = null
    sourceRef.current = null
    currentChunksRef.current = []
    consecutiveSilentFramesRef.current = 0
    consecutiveSpeechFramesRef.current = 0

    console.log('[录音] ✓ 录音已停止')
  }, [minSpeechDuration, stopCurrentSegment, onDataAvailable, onSpeechEnd, onSilenceSubmit, MIN_SPEECH_FRAMES])

  return {
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    isRecording: isRecordingRef.current,
    isPaused: isPausedRef.current,
    analyser: analyserRef.current,
  }
}
