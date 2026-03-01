// API 配置
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api/v1'

// 症状匹配结果
export interface SymptomMatch {
  cui: string
  summary: string
  full_description: string
  confidence_score: number
}

// 语音问诊响应
export interface VoiceConsultationResponse {
  conversation_id: number
  message_id: number
  recognized_text: string
  query: string
  results: SymptomMatch[]
  total_matches: number
}

// 创建会话响应
export interface CreateConversationResponse {
  conversation_id: number
  title: string
  department: string
  created_at: string
}

// 对话详情响应
export interface ConversationDetailResponse {
  conversation_id: number
  title: string
  department: string
  message_count: number
  created_at: string
  updated_at: string
}

/**
 * 创建问诊会话
 * POST /consultation/conversation
 */
export async function createConsultationSession(
  title?: string,
  department?: string,
): Promise<CreateConversationResponse> {
  const response = await fetch(`${API_BASE_URL}/consultation/conversation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: title || '语音问诊',
      department: department || 'General',
    }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: '创建会话失败' }))
    throw new Error(error.detail || '创建会话失败')
  }

  return response.json()
}

/**
 * 语音问诊 - 上传音频并获取转录和症状匹配结果
 * POST /consultation/voice
 */
export async function uploadAudio(
  audioBlob: Blob,
  conversationId?: number,
  options?: {
    audioFormat?: string
    topK?: number
  },
): Promise<VoiceConsultationResponse> {
  const formData = new FormData()
  formData.append('file', audioBlob, 'audio.wav')

  if (conversationId) {
    formData.append('conversation_id', conversationId.toString())
  }

  formData.append('audio_format', options?.audioFormat || 'wav')
  formData.append('top_k', (options?.topK || 5).toString())

  const response = await fetch(`${API_BASE_URL}/consultation/voice`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: '音频转录失败' }))
    throw new Error(error.detail || '音频转录失败')
  }

  return response.json()
}

/**
 * 获取对话详情
 * GET /consultation/conversation/{conversation_id}
 */
export async function getConversationDetail(
  conversationId: number,
): Promise<ConversationDetailResponse> {
  const response = await fetch(`${API_BASE_URL}/consultation/conversation/${conversationId}`)

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: '获取对话详情失败' }))
    throw new Error(error.detail || '获取对话详情失败')
  }

  return response.json()
}
