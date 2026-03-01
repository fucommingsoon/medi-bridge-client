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

// WAV 编码器配置
const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

// 将 PCM Float32 数据编码为 WAV Blob
function encodeWAV(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  // 写入 WAV 头
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // audio format (PCM)
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8, true) // byte rate
  view.setUint16(32, CHANNELS * BITS_PER_SAMPLE / 8, true) // block align
  view.setUint16(34, BITS_PER_SAMPLE, true)
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  // 写入 PCM 数据
  floatTo16BitPCM(view, 44, samples)

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
  }
}

// 合并多个 Float32Array
function mergeFloat32Arrays(arrays: Float32Array[]): Float32Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Float32Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
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
  const processorRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null)

  // 当前片段的 PCM 数据
  const currentPcmDataRef = useRef<Float32Array[]>([])
  const isPausedRecordingRef = useRef(false)

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
  const MIN_SPEECH_FRAMES = 5 // 至少5帧（500ms）连续有声才算说话开始
  const MIN_SILENCE_FRAMES = 5 // 改为5帧（500ms）连续静音就算说话结束

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
  }, [silenceThreshold])

  // 获取当前片段的 WAV Blob
  const getCurrentWavBlob = useCallback((): Blob | null => {
    const pcmData = currentPcmDataRef.current
    if (pcmData.length === 0) return null

    const merged = mergeFloat32Arrays(pcmData)
    const blob = encodeWAV(merged)

    console.log('[录音] WAV Blob 创建成功:', {
      chunks: pcmData.length,
      samples: merged.length,
      size: blob.size,
      duration: (merged.length / SAMPLE_RATE * 1000).toFixed(0) + 'ms',
    })

    return blob
  }, [])

  // 清空当前片段数据
  const clearCurrentSegment = useCallback(() => {
    currentPcmDataRef.current = []
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

    // 调试日志：每秒输出一次状态
    if (import.meta.env.DEV) {
      if (!window['__lastStateLog'] || now - window['__lastStateLog'] > 1000) {
        console.log(`[帧计数] 有声: ${consecutiveSpeechFramesRef.current}/${MIN_SPEECH_FRAMES}, 静音: ${consecutiveSilentFramesRef.current}/${MIN_SILENCE_FRAMES}, 检测到说话: ${isSpeechDetectedRef.current}`)
        window['__lastStateLog'] = now
      }
    }

    // 检测到说话开始：需要连续多帧都有声音
    if (!isSpeechDetectedRef.current && consecutiveSpeechFramesRef.current >= MIN_SPEECH_FRAMES) {
      isSpeechDetectedRef.current = true
      speechStartTimeRef.current = now - (consecutiveSpeechFramesRef.current * 100) // 回推开始时间
      console.log(`[录音] ▶ 检测到开始说话 (连续 ${consecutiveSpeechFramesRef.current} 帧有声)`)
      onSpeechStart?.()
    }

    // 检测到说话结束：需要连续多帧都是静音
    if (isSpeechDetectedRef.current && consecutiveSilentFramesRef.current >= MIN_SILENCE_FRAMES) {
      const speechDurationMs = now - speechStartTimeRef.current
      const silenceDurationMs = consecutiveSilentFramesRef.current * 100

      console.log(`[录音] ◆ 检测到说话结束 (连续 ${consecutiveSilentFramesRef.current} 帧静音, ${silenceDurationMs}ms)，说话时长 ${speechDurationMs}ms，准备提交`)

      if (speechDurationMs >= minSpeechDuration) {
        // 获取当前片段的 WAV blob
        const blob = getCurrentWavBlob()
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

          // 清空当前片段，开始新片段
          clearCurrentSegment()
        }
      } else {
        console.log(`[录音] ✗ 语音片段太短 (${speechDurationMs}ms < ${minSpeechDuration}ms)，已丢弃`)
        isSpeechDetectedRef.current = false
        speechStartTimeRef.current = 0
        consecutiveSilentFramesRef.current = 0
        clearCurrentSegment()
      }
    }
  }, [isSilent, MIN_SPEECH_FRAMES, MIN_SILENCE_FRAMES, minSpeechDuration, getCurrentWavBlob, clearCurrentSegment, onDataAvailable, onSpeechStart, onSpeechEnd, onSilenceSubmit])

  // 创建 AudioWorklet 处理器（内联定义）
  const createAudioWorklet = useCallback(async (audioContext: AudioContext, source: MediaStreamAudioSourceNode) => {
    // 创建一个简单的 AudioWorklet 处理器代码
    const workletCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        process(inputs, outputs, parameters) {
          const input = inputs[0]
          if (input.length > 0) {
            const channelData = input[0]
            this.port.postMessage(channelData.slice(0))
          }
          return true
        }
      }
      registerProcessor('pcm-processor', PCMProcessor)
    `

    const blob = new Blob([workletCode], { type: 'application/javascript' })
    const workletUrl = URL.createObjectURL(blob)

    try {
      await audioContext.audioWorklet.addModule(workletUrl)
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor')

      workletNode.port.onmessage = (event) => {
        if (isPausedRecordingRef.current) return
        const pcmData = event.data as Float32Array
        currentPcmDataRef.current.push(pcmData)
      }

      source.connect(workletNode)
      workletNode.connect(audioContext.destination)

      URL.revokeObjectURL(workletUrl)
      return workletNode
    } catch {
      // 回退到 ScriptProcessorNode
      console.warn('[录音] AudioWorklet 不可用，使用 ScriptProcessorNode')
      const bufferSize = 4096
      const scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1)

      scriptProcessor.onaudioprocess = (event) => {
        if (isPausedRecordingRef.current) return
        const inputData = event.inputBuffer.getChannelData(0)
        currentPcmDataRef.current.push(new Float32Array(inputData))
      }

      source.connect(scriptProcessor)
      scriptProcessor.connect(audioContext.destination)

      return scriptProcessor
    }
  }, [])

  // 开始录音
  const startRecording = useCallback(async () => {
    try {
      console.log('[录音] 正在请求麦克风权限...')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: CHANNELS,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      console.log('[录音] ✓ 麦克风权限获取成功')
      streamRef.current = stream

      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
      audioContextRef.current = audioContext

      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyserRef.current = analyser

      const source = audioContext.createMediaStreamSource(stream)
      sourceRef.current = source
      source.connect(analyser)

      // 创建音频处理器
      const processor = await createAudioWorklet(audioContext, source)
      processorRef.current = processor

      isRecordingRef.current = true
      isPausedRef.current = false
      isPausedRecordingRef.current = false
      isSpeechDetectedRef.current = false
      speechStartTimeRef.current = 0
      silenceStartTimeRef.current = 0
      consecutiveSilentFramesRef.current = 0
      consecutiveSpeechFramesRef.current = 0
      currentPcmDataRef.current = []

      // 启动静音检测定时器
      checkSilenceIntervalRef.current = window.setInterval(checkSilence, 100)

      console.log('[录音] ✓ 录音已启动 (WAV 格式)')
      return true
    } catch (error) {
      console.error('[录音] ✗ 启动失败:', error)
      onError?.(error as Error)
      return false
    }
  }, [checkSilence, createAudioWorklet, onError])

  const pauseRecording = useCallback(() => {
    if (isPausedRef.current) return
    isPausedRef.current = true
    isPausedRecordingRef.current = true

    console.log('[录音] ⏸ 录音已暂停')
  }, [])

  const resumeRecording = useCallback(() => {
    if (!isPausedRef.current) return
    isPausedRef.current = false
    isPausedRecordingRef.current = false

    console.log('[录音] ▶ 录音已恢复')
  }, [])

  const stopRecording = useCallback(async () => {
    console.log('[录音] 正在停止录音...')

    if (checkSilenceIntervalRef.current) {
      clearInterval(checkSilenceIntervalRef.current)
    }

    isPausedRef.current = false
    isPausedRecordingRef.current = false
    isRecordingRef.current = false

    // 提交最后一段语音
    if (isSpeechDetectedRef.current && consecutiveSpeechFramesRef.current >= MIN_SPEECH_FRAMES) {
      const now = Date.now()
      const speechDurationMs = now - speechStartTimeRef.current

      if (speechDurationMs >= minSpeechDuration) {
        const blob = getCurrentWavBlob()
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
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    analyserRef.current = null
    currentPcmDataRef.current = []
    consecutiveSilentFramesRef.current = 0
    consecutiveSpeechFramesRef.current = 0

    console.log('[录音] ✓ 录音已停止')
  }, [minSpeechDuration, getCurrentWavBlob, onDataAvailable, onSpeechEnd, onSilenceSubmit, MIN_SPEECH_FRAMES])

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
