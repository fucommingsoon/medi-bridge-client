import { useState, useEffect, useRef } from 'react'
import { useAudioRecorder } from './hooks/useAudioRecorder'
import { createConsultationSession, uploadAudio, SymptomMatch } from './api/consultation'
import { AudioWaveform } from './components/AudioWaveform'

// 页面状态
type PageState = 'home' | 'consulting'

// 转录消息类型
interface TranscriptionMessage {
  id: string
  content: string
  timestamp: Date
}

// 语音片段记录
interface VoiceClip {
  id: string
  blob: Blob // 音频数据
  blobSize: number // KB
  duration: number // ms
  submitTime: Date
  transcription?: string // 转录结果
}

// 匹配的症状
interface MatchedSymptom {
  summary: string
  confidence: number
  description: string
}

function App() {
  const [pageState, setPageState] = useState<PageState>('home')
  const [messages, setMessages] = useState<TranscriptionMessage[]>([])
  const [symptoms, setSymptoms] = useState<MatchedSymptom[]>([])
  const [voiceClips, setVoiceClips] = useState<VoiceClip[]>([])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [playingClipId, setPlayingClipId] = useState<string | null>(null)
  const [playProgress, setPlayProgress] = useState(0) // 播放进度 0-100
  const [showVoiceClipsPanel, setShowVoiceClipsPanel] = useState(false) // 控制语音片段面板显示
  const conversationIdRef = useRef<number | null>(null) // 使用 ref 存储会话 ID，避免闭包问题
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const currentAudioUrlRef = useRef<string | null>(null) // 当前使用的音频 URL
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const voiceClipsEndRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    voiceClipsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, voiceClips])

  // 清理音频播放器
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current)
        currentAudioUrlRef.current = null
      }
    }
  }, [])

  // 播放语音片段
  const handlePlayClip = (clip: VoiceClip) => {
    // 如果正在播放这个片段，则暂停
    if (playingClipId === clip.id && audioRef.current) {
      audioRef.current.pause()
      setPlayingClipId(null)
      setPlayProgress(0)
      return
    }

    // 停止之前的播放并释放 URL
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current)
      currentAudioUrlRef.current = null
    }

    // 创建音频 URL
    const audioUrl = URL.createObjectURL(clip.blob)
    currentAudioUrlRef.current = audioUrl

    console.log('[播放] 创建音频 URL:', {
      clipId: clip.id,
      blobSize: clip.blob.size,
      blobType: clip.blob.type,
      audioUrl: audioUrl,
    })

    // 创建新的音频播放器
    const audio = new Audio()
    audio.src = audioUrl

    // 更新播放进度
    audio.ontimeupdate = () => {
      if (audio.duration) {
        setPlayProgress((audio.currentTime / audio.duration) * 100)
      }
    }

    audio.onended = () => {
      setPlayingClipId(null)
      setPlayProgress(0)
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current)
        currentAudioUrlRef.current = null
      }
    }

    audio.onerror = (e) => {
      console.error('[播放] 错误:', {
        event: e,
        clipId: clip.id,
        blobSize: clip.blob.size,
        blobType: clip.blob.type,
        audioUrl: audioUrl,
        audioSrc: audio.src,
        error: audio.error?.message,
      })
      setPlayingClipId(null)
      setPlayProgress(0)
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current)
        currentAudioUrlRef.current = null
      }
    }

    audio.play().catch((err) => {
      console.error('[播放] play() 错误:', err)
      setPlayingClipId(null)
    })

    audioRef.current = audio
    setPlayingClipId(clip.id)
  }

  // 暂停/继续问诊
  const handlePauseResume = () => {
    if (isPaused) {
      resumeRecording()
      setIsPaused(false)
    } else {
      pauseRecording()
      setIsPaused(true)
    }
  }

  // 保存音频到本地
  const handleSaveClip = (clip: VoiceClip) => {
    // 创建下载链接
    const url = URL.createObjectURL(clip.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `语音片段_${new Date().getTime()}.webm`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    console.log('[保存] 音频已保存:', a.download)
  }

  // 停止所有播放
  const stopAllPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current)
      currentAudioUrlRef.current = null
    }
    setPlayingClipId(null)
  }

  // 临时存储当前语音片段的信息（用于 API 返回时更新转录文本）
  const pendingClipIdRef = useRef<string | null>(null)

  // 使用录音 hook
  const { startRecording, stopRecording, pauseRecording, resumeRecording, analyser: recorderAnalyser } = useAudioRecorder({
    onDataAvailable: async (audioBlob) => {
      const currentConversationId = conversationIdRef.current
      if (!currentConversationId) {
        console.warn('[API] conversationId 为空，跳过发送')
        return
      }

      const blobSize = (audioBlob.size / 1024)
      const startTime = Date.now()
      console.log(`[API] → 立即发送音频到服务器... (${blobSize.toFixed(2)}KB), 会话ID: ${currentConversationId}`)

      try {
        const result = await uploadAudio(audioBlob, currentConversationId)
        const elapsed = Date.now() - startTime

        console.log(`[API] ✓ 服务器响应 (${elapsed}ms):`, {
          text: result.recognized_text,
          matches: result.total_matches,
        })

        console.log('[API] ✓ 服务器响应:', {
          text: result.recognized_text,
          matches: result.total_matches,
        })

        // 添加转录消息
        if (result.recognized_text) {
          setMessages((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random()}`,
              content: result.recognized_text,
              timestamp: new Date(),
            },
          ])
        }

        // 更新对应的语音片段的转录文本
        if (pendingClipIdRef.current) {
          setVoiceClips((prev) =>
            prev.map((clip) =>
              clip.id === pendingClipIdRef.current
                ? { ...clip, transcription: result.recognized_text }
                : clip
            )
          )
          pendingClipIdRef.current = null
        }

        // 更新症状匹配信息
        if (result.results && result.results.length > 0) {
          const symptomNames = result.results.map(r => r.summary).join(', ')
          console.log('[症状] 匹配到的症状:', symptomNames)
          setSymptoms(
            result.results.map((r) => ({
              summary: r.summary,
              confidence: r.confidence_score,
              description: r.full_description,
            })),
          )
        }
      } catch (error) {
        console.error('[API] ✗ 请求失败:', error)
      }
    },
    onError: (error) => {
      console.error('[录音] ✗ 错误:', error)
      setIsRecording(false)
    },
    onSpeechStart: () => {
      setIsSpeaking(true)
    },
    onSpeechEnd: (duration) => {
      setIsSpeaking(false)
      console.log(`[UI] 说话结束，时长: ${duration}ms`)
    },
    onSilenceSubmit: (blob, blobSize, duration) => {
      // 前端检测到语音片段后立即添加到列表
      const clipId = `${Date.now()}-${Math.random()}`
      console.log('[UI] 收到语音片段:', {
        clipId,
        blobSize: blob.size,
        blobType: blob.type,
        duration,
      })
      const clip: VoiceClip = {
        id: clipId,
        blob: blob,
        blobSize: blobSize,
        duration: duration,
        submitTime: new Date(),
      }
      setVoiceClips((prev) => [...prev, clip])
      console.log(`[UI] ✓ 检测到语音片段: ${clip.blobSize.toFixed(2)}KB, ${clip.duration}ms`)

      // 保存 clipId 用于 API 返回时更新转录文本
      pendingClipIdRef.current = clipId
    },
    // 静音检测配置
    silenceThreshold: 0.15, // 音量阈值 0-1，提高到 15% 更严格过滤噪音
    silenceDuration: 2000, // 静音 2 秒后提交（给说话留更多缓冲）
    minSpeechDuration: 800, // 最小语音时长 0.8 秒，过滤过短的片段
  })

  // 同步 analyser
  useEffect(() => {
    setAnalyser(recorderAnalyser)
  }, [recorderAnalyser])

  // 开始问诊
  const handleStartConsultation = async () => {
    try {
      // 创建会话
      const session = await createConsultationSession('语音问诊', 'General')
      const cid = session.conversation_id

      // 同时更新 ref 和 state（ref 立即生效，state 用于 UI 渲染）
      conversationIdRef.current = cid
      setConversationId(cid)

      console.log('[会话] 已创建会话，ID:', cid)

      // 开始录音
      const started = await startRecording()
      if (started) {
        setIsRecording(true)
        setPageState('consulting')
      }
    } catch (error) {
      console.error('开始问诊失败:', error)
      alert('启动问诊失败，请检查麦克风权限和网络连接')
    }
  }

  // 结束问诊
  const handleEndConsultation = async () => {
    stopRecording()
    setIsRecording(false)
    setIsPaused(false)
    stopAllPlayback()

    setPageState('home')
    setMessages([])
    setSymptoms([])
    setVoiceClips([])
    setConversationId(null)
    conversationIdRef.current = null
    pendingClipIdRef.current = null
  }

  // 清理：组件卸载时停止录音
  useEffect(() => {
    return () => {
      if (isRecording) {
        stopRecording()
      }
    }
  }, [])

  // 主页
  if (pageState === 'home') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-blue-100 flex flex-col">
        {/* 顶部标题 */}
        <header className="px-6 pt-12 pb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">Medi Bridge</h1>
              <p className="text-gray-600">智能诊室辅助系统</p>
            </div>
          </div>
        </header>

        {/* 主内容 */}
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="w-full max-w-sm">
            {/* 说明卡片 */}
            <div className="bg-white rounded-3xl shadow-xl p-8 mb-6">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-10 h-10 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 mb-2">开始辅助问诊</h2>
                <p className="text-gray-500 text-sm">
                  系统将自动录制对话并实时转录，<br />
                  同时智能分析可能的病症
                </p>
              </div>

              {/* 开始按钮 */}
              <button
                onClick={handleStartConsultation}
                className="w-full bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold py-4 rounded-2xl shadow-lg hover:shadow-xl active:scale-[0.98] transition-all"
              >
                开始问诊
              </button>
            </div>

            {/* 功能说明 */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-white/60 backdrop-blur rounded-2xl p-4 text-center">
                <div className="text-2xl mb-2">🎤</div>
                <p className="text-xs text-gray-600">实时录音</p>
              </div>
              <div className="bg-white/60 backdrop-blur rounded-2xl p-4 text-center">
                <div className="text-2xl mb-2">📝</div>
                <p className="text-xs text-gray-600">对话转录</p>
              </div>
              <div className="bg-white/60 backdrop-blur rounded-2xl p-4 text-center">
                <div className="text-2xl mb-2">🔍</div>
                <p className="text-xs text-gray-600">病症分析</p>
              </div>
            </div>
          </div>
        </main>

        {/* 底部 */}
        <footer className="px-6 py-6 text-center">
          <p className="text-xs text-gray-400">辅助诊断仅供参考 · 请以医生判断为准</p>
        </footer>
      </div>
    )
  }

  // 问诊中页面
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* 顶部 */}
      <header className="bg-white shadow-sm sticky top-0 z-50">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isRecording && !isPaused && (
              <>
                <div className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-green-500 scale-150' : 'bg-red-500'} transition-all duration-200`}></div>
                <span className="text-sm text-gray-600">
                  {isSpeaking ? '正在说话...' : '录音中'}
                </span>
              </>
            )}
            {isRecording && isPaused && (
              <>
                <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                <span className="text-sm text-gray-600">已暂停</span>
              </>
            )}
            {!isRecording && (
              <span className="text-sm text-gray-400">已停止</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isRecording && (
              <button
                onClick={handlePauseResume}
                className="px-4 py-2 bg-yellow-50 text-yellow-600 rounded-lg text-sm font-medium active:bg-yellow-100"
              >
                {isPaused ? '▶ 继续' : '⏸ 暂停'}
              </button>
            )}
            <button
              onClick={handleEndConsultation}
              className="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm font-medium active:bg-red-100"
            >
              结束问诊
            </button>
          </div>
        </div>
      </header>

      {/* 主内容 */}
      <main className="flex-1 overflow-auto px-4 py-4 pb-safe-bottom">
        <div className="max-w-2xl mx-auto space-y-4">
          {/* 声波可视化 */}
          {analyser && (
            <section className="bg-white rounded-2xl shadow-sm p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-lg">🎤</span>
                  音频录入
                </h3>
                <span className="text-xs text-gray-400">
                  {isSpeaking ? '正在录音...' : '等待语音...'}
                </span>
              </div>
              <AudioWaveform analyser={analyser} isRecording={isRecording} isPaused={isPaused} silenceThreshold={0.15} />
            </section>
          )}

          {/* 症状匹配结果 */}
          {symptoms.length > 0 && (
            <section className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <span className="text-lg">🔍</span>
                识别的症状
              </h3>
              <div className="space-y-2">
                {symptoms.map((symptom, index) => (
                  <div key={index} className="bg-blue-50 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-gray-900">{symptom.summary}</span>
                      <span className="text-sm text-blue-600 font-medium">
                        {Math.round(symptom.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">{symptom.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 对话记录 */}
          <section className="bg-white rounded-2xl shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <span className="text-lg">💬</span>
              对话记录
            </h3>
            <div className="space-y-3">
              {messages.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">
                  等待对话...
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className="bg-gray-50 rounded-2xl rounded-tl-none px-4 py-3"
                    >
                      <p className="text-sm text-gray-800">{msg.content}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {msg.timestamp.toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </p>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>
          </section>
        </div>
      </main>

      {/* 浮动语音片段面板按钮 */}
      {pageState === 'consulting' && (
        <>
          {/* 浮动按钮 */}
          <button
            onClick={() => setShowVoiceClipsPanel(!showVoiceClipsPanel)}
            className="fixed bottom-6 right-6 z-50 bg-blue-500 hover:bg-blue-600 text-white rounded-full shadow-lg flex items-center gap-2 px-4 py-3 transition-all"
          >
            <span className="text-xl">🎵</span>
            <span className="text-sm font-medium">{voiceClips.length} 片段</span>
            {showVoiceClipsPanel ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </button>

          {/* 浮动面板 */}
          {showVoiceClipsPanel && (
            <div className="fixed bottom-20 right-6 z-50 w-80 max-h-[60vh] bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col">
              {/* 面板头部 */}
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                  <span>🎵</span>
                  检测到的语音片段
                  <span className="text-xs text-gray-400 font-normal">({voiceClips.length})</span>
                </h3>
                <button
                  onClick={() => setShowVoiceClipsPanel(false)}
                  className="p-1 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* 片段列表 */}
              <div className="flex-1 overflow-auto p-3 space-y-2">
                {voiceClips.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">
                    等待语音输入...
                  </div>
                ) : (
                  <>
                    {voiceClips.map((clip) => (
                      <div
                        key={clip.id}
                        className="bg-gray-50 rounded-xl px-3 py-2"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handlePlayClip(clip)}
                                className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                                  playingClipId === clip.id
                                    ? 'bg-blue-500 text-white'
                                    : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
                                }`}
                                title="播放"
                              >
                                {playingClipId === clip.id ? (
                                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                                  </svg>
                                ) : (
                                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M8 5v14l11-7z" />
                                  </svg>
                                )}
                              </button>
                              <button
                                onClick={() => handleSaveClip(clip)}
                                className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                                title="保存到本地"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l4-4m-4 4h4" />
                                </svg>
                              </button>
                            </div>
                            <div>
                              <div className="flex items-center gap-1">
                                <span className="text-xs font-medium text-gray-900">
                                  {(clip.duration / 1000).toFixed(1)}秒
                                </span>
                                <span className="text-xs text-gray-400">·</span>
                                <span className="text-xs text-gray-500">{clip.blobSize.toFixed(1)}KB</span>
                              </div>
                              <p className="text-xs text-gray-400">
                                {clip.submitTime.toLocaleTimeString('zh-CN', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}
                              </p>
                            </div>
                          </div>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                            {clip.transcription ? '✓' : '⏳'}
                          </span>
                        </div>
                        {/* 播放进度条 */}
                        {playingClipId === clip.id && (
                          <div className="mb-2">
                            <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 transition-all duration-100"
                                style={{ width: `${playProgress}%` }}
                              ></div>
                            </div>
                          </div>
                        )}
                        {clip.transcription && (
                          <div className="pt-1 border-t border-gray-200">
                            <p className="text-xs text-gray-700 line-clamp-2">"{clip.transcription}"</p>
                          </div>
                        )}
                      </div>
                    ))}
                    <div ref={voiceClipsEndRef} />
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default App
