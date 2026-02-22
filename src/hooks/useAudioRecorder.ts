import { useRef, useCallback } from 'react'

interface AudioRecorderOptions {
  onDataAvailable: (blob: Blob) => void
  onError?: (error: Error) => void
  onSpeechStart?: () => void // 检测到开始说话
  onSpeechEnd?: (duration: number) => void // 检测到说话结束，参数为说话时长(ms)
  onSilenceSubmit?: (blob: Blob, blobSize: number, duration: number) => void // 提交语音片段时触发，参数为blob、大小(KB)和时长(ms)
  // 静音检测配置
  silenceThreshold?: number // 静音阈值 0-1，默认 0.02
  silenceDuration?: number // 静音持续时间（毫秒），默认 1500ms
  minSpeechDuration?: number // 最小语音时长（毫秒），默认 500ms
}

interface AudioRecorderReturn {
  startRecording: () => Promise<boolean>
  stopRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  isRecording: boolean
  isPaused: boolean
  analyser: AnalyserNode | null // 暴露 analyser 用于可视化
}

export function useAudioRecorder({
  onDataAvailable,
  onError,
  onSpeechStart,
  onSpeechEnd,
  onSilenceSubmit,
  silenceThreshold = 0.02,
  silenceDuration = 1500,
  minSpeechDuration = 500,
}: AudioRecorderOptions): AudioRecorderReturn {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

  // 音频数据缓冲区
  const speechChunksRef = useRef<Blob[]>([] as Blob[])
  const silenceChunksRef = useRef<Blob[]>([] as Blob[])

  // 状态追踪
  const isPausedRef = useRef(false)
  const isSpeechDetectedRef = useRef(false)
  const speechStartTimeRef = useRef<number>(0)
  const silenceStartTimeRef = useRef<number>(0)
  const checkSilenceIntervalRef = useRef<number>()

  // 分析音频数据判断是否为静音
  const isSilent = useCallback((analyser: AnalyserNode): boolean => {
    const dataArray = new Uint8Array(analyser.fftSize)
    analyser.getByteFrequencyData(dataArray)

    // 计算平均音量
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i]
    }
    const average = sum / dataArray.length

    // 归一化到 0-1
    const normalized = average / 255

    // 开发环境输出音量日志（每秒输出一次）
    if (import.meta.env.DEV) {
      const now = Date.now()
      if (!window['__lastVolumeLog'] || now - window['__lastVolumeLog'] > 1000) {
        console.log(`[音量] 当前: ${(normalized * 100).toFixed(1)}%, 阈值: ${(silenceThreshold * 100).toFixed(1)}%`)
        window['__lastVolumeLog'] = now
      }
    }

    return normalized < silenceThreshold
  }, [silenceThreshold])

  // 检查静音状态并提交语音片段
  const checkSilence = useCallback(() => {
    const analyser = analyserRef.current
    const mediaRecorder = mediaRecorderRef.current

    if (!analyser || !mediaRecorder || mediaRecorder.state !== 'recording' || isPausedRef.current) {
      return
    }

    const isCurrentlySilent = isSilent(analyser)
    const now = Date.now()

    if (isCurrentlySilent) {
      // 检测到静音
      if (isSpeechDetectedRef.current) {
        // 之前在说话，现在静音了
        if (!silenceStartTimeRef.current) {
          silenceStartTimeRef.current = now
          console.log('[录音] 检测到静音开始...')
        }

        const silenceDurationMs = now - silenceStartTimeRef.current

        // 如果静音持续时间超过阈值，提交语音片段
        if (silenceDurationMs >= silenceDuration) {
          const speechDurationMs = now - speechStartTimeRef.current

          console.log(`[录音] 静音持续 ${silenceDurationMs}ms，说话时长 ${speechDurationMs}ms`)

          // 只有语音片段足够长才提交
          if (speechDurationMs >= minSpeechDuration && speechChunksRef.current.length > 0) {
            const blob = new Blob(speechChunksRef.current, { type: 'audio/webm;codecs=opus' })
            const blobSize = blob.size / 1024
            console.log(`[录音] ✓ 提交语音片段: ${blobSize.toFixed(2)}KB, 时长: ${speechDurationMs}ms`)
            // 先调用 onSpeechEnd，再调用 onSilenceSubmit（传递 blob、大小和时长）
            onSpeechEnd?.(speechDurationMs)
            onSilenceSubmit?.(blob, blobSize, speechDurationMs)
            onDataAvailable(blob)
          } else {
            console.log(`[录音] ✗ 语音片段太短 (${speechDurationMs}ms < ${minSpeechDuration}ms)，已丢弃`)
          }

          // 重置状态
          speechChunksRef.current = []
          silenceChunksRef.current = []
          isSpeechDetectedRef.current = false
          speechStartTimeRef.current = 0
          silenceStartTimeRef.current = 0
        }
      }

      // 将静音数据存储到静音缓冲区
      if (silenceChunksRef.current.length > 0) {
        // 合并连续的静音数据
        const lastBlob = silenceChunksRef.current[silenceChunksRef.current.length - 1]
        // 保持静音数据不超过一定大小
        if (lastBlob.size < 50000) {
          // 继续累积
        }
      }
    } else {
      // 检测到声音
      if (silenceStartTimeRef.current) {
        console.log('[录音] 静音结束，检测到新的语音')
      }

      silenceStartTimeRef.current = 0

      if (!isSpeechDetectedRef.current) {
        // 开始新的语音片段
        isSpeechDetectedRef.current = true
        speechStartTimeRef.current = now
        console.log('[录音] ▶ 检测到开始说话')
        onSpeechStart?.()
      }

      // 将静音缓冲区的数据也加入语音片段（保留停顿前的音频）
      if (silenceChunksRef.current.length > 0) {
        speechChunksRef.current.push(...silenceChunksRef.current)
        silenceChunksRef.current = []
      }
    }
  }, [isSilent, silenceDuration, minSpeechDuration, onDataAvailable, onSpeechStart, onSpeechEnd, onSilenceSubmit])

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

      // 创建 AudioContext 用于音量分析
      const audioContext = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioContext

      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyserRef.current = analyser

      const source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)
      sourceRef.current = source

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      })

      mediaRecorderRef.current = mediaRecorder
      speechChunksRef.current = []
      silenceChunksRef.current = []
      isSpeechDetectedRef.current = false
      speechStartTimeRef.current = 0
      silenceStartTimeRef.current = 0

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          if (isSpeechDetectedRef.current) {
            speechChunksRef.current.push(event.data)
          } else {
            silenceChunksRef.current.push(event.data)
          }
        }
      }

      mediaRecorder.start(100) // 每100ms产生一次数据块

      // 启动静音检测定时器（每100ms检查一次）
      checkSilenceIntervalRef.current = window.setInterval(checkSilence, 100)

      console.log('[录音] ✓ 录音已启动')
      return true
    } catch (error) {
      console.error('[录音] ✗ 启动失败:', error)
      onError?.(error as Error)
      return false
    }
  }, [checkSilence, onError])

  // 暂停录音
  const pauseRecording = useCallback(() => {
    if (isPausedRef.current) return
    isPausedRef.current = true
    console.log('[录音] ⏸ 录音已暂停')
  }, [])

  // 继续录音
  const resumeRecording = useCallback(() => {
    if (!isPausedRef.current) return
    isPausedRef.current = false
    console.log('[录音] ▶ 录音已恢复')
  }, [])

  // 停止录音
  const stopRecording = useCallback(() => {
    console.log('[录音] 正在停止录音...')

    // 停止静音检测
    if (checkSilenceIntervalRef.current) {
      clearInterval(checkSilenceIntervalRef.current)
    }

    // 如果正在暂停状态，先恢复
    if (isPausedRef.current) {
      isPausedRef.current = false
    }

    // 提交剩余的语音数据
    if (speechChunksRef.current.length > 0 && isSpeechDetectedRef.current) {
      const now = Date.now()
      const speechDurationMs = now - speechStartTimeRef.current

      if (speechDurationMs >= minSpeechDuration) {
        const blob = new Blob(speechChunksRef.current, { type: 'audio/webm;codecs=opus' })
        const blobSize = blob.size / 1024
        console.log(`[录音] ✓ 提交最后一段语音: ${blobSize.toFixed(2)}KB, 时长: ${speechDurationMs}ms`)
        // 先调用 onSpeechEnd，再调用 onSilenceSubmit（传递 blob、大小和时长）
        onSpeechEnd?.(speechDurationMs)
        onSilenceSubmit?.(blob, blobSize, speechDurationMs)
        onDataAvailable(blob)
      }
    }

    // 重置缓冲区
    speechChunksRef.current = []
    silenceChunksRef.current = []
    isSpeechDetectedRef.current = false
    speechStartTimeRef.current = 0
    silenceStartTimeRef.current = 0

    // 停止录音器
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }

    // 断开音频处理
    if (sourceRef.current) {
      sourceRef.current.disconnect()
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close()
    }

    // 停止媒体流
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    mediaRecorderRef.current = null
    audioContextRef.current = null
    analyserRef.current = null
    sourceRef.current = null

    console.log('[录音] ✓ 录音已停止')
  }, [minSpeechDuration, onDataAvailable])

  return {
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    isRecording: mediaRecorderRef.current?.state === 'recording',
    isPaused: isPausedRef.current,
    analyser: analyserRef.current,
  }
}
