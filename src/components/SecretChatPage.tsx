import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft,
  MessageSquare,
  Key,
  RefreshCw,
  Send,
  LogOut,
  Clock,
  Users,
  User,
  Paperclip,
  Edit2,
  Pin,
  Check,
  CheckCheck,
  AlertTriangle,
  Copy,
  X,
  File,
  Image as ImageIcon,
  Music,
  Reply,
  Mic,
  Square,
  Trash2,
  ChevronDown,
} from 'lucide-react';
import { encryptData, decryptData, generateSecureKey } from '../lib/crypto';
import { cn } from '../lib/utils';
import { db } from '../firebase';
import {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
  setDoc,
  updateDoc,
  Timestamp,
} from 'firebase/firestore';

interface FileAttachment {
  name: string;
  type: string;
  data: string; // base64 encrypted data
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  expiresAt: number;
  isSelf: boolean;
  isEdited?: boolean;
  fileAttachment?: FileAttachment;
  readBy?: string[];
  messageKey?: string;
  reactions?: Record<string, string[]>;
  replyTo?: { id: string; sender: string; text: string };
}

interface ChatParticipant {
  id: string;
  name: string;
  lastActive: number;
  isTyping?: boolean;
}

export default function SecretChatPage({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<'setup' | 'chat'>('setup');
  const [roomCode, setRoomCode] = useState('');
  const [userName, setUserName] = useState('');
  const [expiryMinutes, setExpiryMinutes] = useState(10);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [error, setError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [isReconnecting, setIsReconnecting] = useState(false);

  // New features state
  const [screenshotWarning, setScreenshotWarning] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(null);
  const [fileAttachment, setFileAttachment] = useState<File | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const [participantId] = useState(() =>
    Math.random().toString(36).substring(2, 15)
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const unsubscribeMessagesRef = useRef<() => void>();
  const unsubscribeParticipantsRef = useRef<() => void>();
  const unsubscribeMetadataRef = useRef<() => void>();
  const heartbeatIntervalRef = useRef<NodeJS.Timeout>();
  const handleOnlineRef = useRef<() => void>();
  const handleOfflineRef = useRef<() => void>();
  const typingTimeoutRef = useRef<NodeJS.Timeout>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout>();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Check for invite link
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomCode(roomParam);
    }

    // Screenshot detection
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'PrintScreen') {
        setScreenshotWarning(true);
        setTimeout(() => setScreenshotWarning(false), 3000);
      }
    };
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keyup', handleKeyUp);
      handleLeaveRoom();
    };
  }, []);

  // Handle disappearing messages
  useEffect(() => {
    if (step !== 'chat') return;
    const interval = setInterval(() => {
      const now = Date.now();
      setMessages((prev) => {
        const filtered = prev.filter((msg) => msg.expiresAt > now);
        if (filtered.length !== prev.length) return filtered;
        return prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [step]);

  const handleGenerateRoom = () => {
    setRoomCode(generateSecureKey().substring(0, 12));
  };

  const handleJoinChat = async () => {
    if (!navigator.onLine) {
      setError('You are currently offline. Please check your connection.');
      return;
    }

    const trimmedRoomCode = roomCode.trim();
    const trimmedUserName = userName.trim();

    if (!trimmedRoomCode) {
      setError('Please enter a room code');
      return;
    }
    if (!trimmedUserName) {
      setError('Please enter your name');
      return;
    }
    if (trimmedRoomCode.length < 8) {
      setError('Room code must be at least 8 characters long');
      return;
    }

    setRoomCode(trimmedRoomCode);
    setUserName(trimmedUserName);
    setError('');

    try {
      // Register participant
      const participantRef = doc(
        db,
        'chatRooms',
        trimmedRoomCode,
        'participants',
        participantId
      );
      await setDoc(participantRef, {
        name: trimmedUserName,
        lastActive: Date.now(),
        isTyping: false,
      });

      // Start heartbeat
      heartbeatIntervalRef.current = setInterval(async () => {
        if (!navigator.onLine) return;
        try {
          await setDoc(
            participantRef,
            {
              lastActive: Date.now(),
            },
            { merge: true }
          );
        } catch (e) {
          console.error('Heartbeat failed', e);
        }
      }, 15000);

      const handleOnline = () => {
        setIsReconnecting(false);
        setDoc(
          participantRef,
          {
            lastActive: Date.now(),
          },
          { merge: true }
        ).catch(console.error);
      };

      const handleOffline = () => {
        setIsReconnecting(true);
      };

      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      handleOnlineRef.current = handleOnline;
      handleOfflineRef.current = handleOffline;

      // Listen for participants
      const participantsQuery = query(
        collection(db, 'chatRooms', trimmedRoomCode, 'participants')
      );
      unsubscribeParticipantsRef.current = onSnapshot(
        participantsQuery,
        (snapshot) => {
          const activeUsers: ChatParticipant[] = [];
          snapshot.forEach((doc) => {
            const data = doc.data();
            activeUsers.push({
              id: doc.id,
              name: data.name,
              lastActive: data.lastActive,
              isTyping: data.isTyping,
            });
          });
          setParticipants(activeUsers);
        },
        (err) => {
          console.error('Participants listener error:', err);
        }
      );

      // Listen for metadata (pinned messages)
      const metadataRef = doc(db, 'chatRooms', trimmedRoomCode, 'metadata', 'info');
      unsubscribeMetadataRef.current = onSnapshot(metadataRef, (doc) => {
        if (doc.exists()) {
          setPinnedMessageId(doc.data().pinnedMessageId || null);
        }
      });

      // Listen for messages
      const messagesQuery = query(
        collection(db, 'chatRooms', trimmedRoomCode, 'messages'),
        orderBy('timestamp', 'asc')
      );

      unsubscribeMessagesRef.current = onSnapshot(
        messagesQuery,
        async (snapshot) => {
          const newMessages: ChatMessage[] = [];
          const now = Date.now();

          for (const change of snapshot.docChanges()) {
            const data = change.doc.data();
            let expiresAtMs = 0;
            if (data.expiresAt?.toMillis) {
              expiresAtMs = data.expiresAt.toMillis();
            } else if (data.expiresAt?.seconds) {
              expiresAtMs = data.expiresAt.seconds * 1000;
            } else if (typeof data.expiresAt === 'number') {
              expiresAtMs = data.expiresAt;
            }

            if (expiresAtMs > now) {
              try {
                // Perfect Forward Secrecy: decrypt the message key first
                let messageKey = trimmedRoomCode;
                if (data.encryptedKey) {
                  const decryptedKeyData = await decryptData(
                    data.encryptedKey,
                    trimmedRoomCode
                  );
                  messageKey = new TextDecoder().decode(decryptedKeyData.data);
                }

                const decrypted = await decryptData(data.ciphertext, messageKey);
                const msgData = JSON.parse(
                  new TextDecoder().decode(decrypted.data)
                );

                const isSelf = msgData.sender === trimmedUserName;

                if (change.type === 'added' || change.type === 'modified') {
                  newMessages.push({
                    ...msgData,
                    id: change.doc.id,
                    timestamp: data.timestamp,
                    expiresAt: expiresAtMs,
                    isSelf,
                    isEdited: data.isEdited,
                    readBy: data.readBy || [],
                    reactions: data.reactions || {},
                    messageKey,
                  });

                  // Send read receipt if not self and not already read
                  if (!isSelf && !(data.readBy || []).includes(trimmedUserName)) {
                    updateDoc(change.doc.ref, {
                      readBy: [...(data.readBy || []), trimmedUserName],
                    }).catch(() => {});
                  }
                }
              } catch (err) {
                console.error('Failed to decrypt message', err);
              }
            } else {
              // Optionally clean up expired messages from Firestore
              try {
                deleteDoc(change.doc.ref);
              } catch (e) {}
            }
          }

          if (newMessages.length > 0) {
            setMessages((prev) => {
              const combined = [...prev];
              newMessages.forEach((newMsg) => {
                const existingIndex = combined.findIndex((m) => m.id === newMsg.id);
                if (existingIndex >= 0) {
                  combined[existingIndex] = newMsg;
                } else {
                  combined.push(newMsg);
                }
              });
              return combined.sort((a, b) => a.timestamp - b.timestamp);
            });
          }
        },
        (err) => {
          console.error('Messages listener error:', err);
          setError(
            'Unable to join room. Please check the room ID or connection.'
          );
          handleLeaveRoom();
        }
      );

      setStep('chat');
    } catch (err) {
      console.error('Failed to join room', err);
      setError('Unable to join room. Please check the room ID or connection.');
    }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);

    if (!roomCode || !participantId) return;

    setDoc(
      doc(db, 'chatRooms', roomCode, 'participants', participantId),
      { isTyping: true },
      { merge: true }
    ).catch(() => {});

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setDoc(
        doc(db, 'chatRooms', roomCode, 'participants', participantId),
        { isTyping: false },
        { merge: true }
      ).catch(() => {});
    }, 2000);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!newMessage.trim() && !fileAttachment) || isReconnecting || !navigator.onLine)
      return;

    setIsSending(true);
    const messageText = newMessage;
    const currentAttachment = fileAttachment;
    setNewMessage('');
    setFileAttachment(null);
    setReplyingTo(null);

    // Clear typing status
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    setDoc(
      doc(db, 'chatRooms', roomCode, 'participants', participantId),
      { isTyping: false },
      { merge: true }
    ).catch(() => {});

    try {
      const timestamp = Date.now();
      const expiresAtMs = timestamp + expiryMinutes * 60 * 1000;
      const expiresAt = Timestamp.fromMillis(expiresAtMs);

      // Perfect Forward Secrecy: Generate a fresh key for this message
      const messageKey = generateSecureKey();
      const encryptedMessageKey = await encryptData(
        new TextEncoder().encode(messageKey),
        roomCode,
        'text'
      );

      let attachmentData;
      if (currentAttachment) {
        const buffer = await currentAttachment.arrayBuffer();
        const encryptedFile = await encryptData(
          new Uint8Array(buffer),
          messageKey,
          'text'
        );
        attachmentData = {
          name: currentAttachment.name,
          type: currentAttachment.type,
          data: encryptedFile,
        };
      }

      const messageData = {
        sender: userName,
        text: messageText,
        fileAttachment: attachmentData,
        replyTo: replyingTo ? { id: replyingTo.id, sender: replyingTo.sender, text: replyingTo.text } : undefined,
      };

      const dataToEncrypt = new TextEncoder().encode(
        JSON.stringify(messageData)
      );
      const ciphertext = await encryptData(dataToEncrypt, messageKey, 'text');

      if (editingMessageId) {
        await updateDoc(doc(db, 'chatRooms', roomCode, 'messages', editingMessageId), {
          ciphertext,
          encryptedKey: encryptedMessageKey,
          isEdited: true,
        });
        setEditingMessageId(null);
      } else {
        await addDoc(collection(db, 'chatRooms', roomCode, 'messages'), {
          ciphertext,
          encryptedKey: encryptedMessageKey,
          sender: userName,
          timestamp,
          expiresAt,
          readBy: [userName], // Sender has read it
        });
      }
    } catch (err) {
      console.error('Failed to send message', err);
      setError('Failed to encrypt and send message');
      setNewMessage(messageText);
      setFileAttachment(currentAttachment);
    } finally {
      setIsSending(false);
    }
  };

  const handlePinMessage = async (msgId: string) => {
    try {
      await setDoc(
        doc(db, 'chatRooms', roomCode, 'metadata', 'info'),
        { pinnedMessageId: pinnedMessageId === msgId ? null : msgId },
        { merge: true }
      );
    } catch (e) {
      console.error('Failed to pin message', e);
    }
  };

  const handleReact = async (msgId: string, emoji: string) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg) return;

    const currentReactions = msg.reactions || {};
    const usersForEmoji = currentReactions[emoji] || [];
    const hasReacted = usersForEmoji.includes(userName);

    let newUsers;
    if (hasReacted) {
      newUsers = usersForEmoji.filter((u) => u !== userName);
    } else {
      newUsers = [...usersForEmoji, userName];
    }

    const newReactions = {
      ...currentReactions,
      [emoji]: newUsers,
    };

    if (newUsers.length === 0) {
      delete newReactions[emoji];
    }

    try {
      await updateDoc(doc(db, 'chatRooms', roomCode, 'messages', msgId), {
        reactions: newReactions,
      });
    } catch (err) {
      console.error('Failed to update reaction', err);
    }
  };

  const handleEditMessage = (msg: ChatMessage) => {
    setNewMessage(msg.text);
    setEditingMessageId(msg.id);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024) {
      setError('File size must be less than 500KB due to storage limits.');
      return;
    }
    setFileAttachment(file);
    setError('');
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([audioBlob], `Voice Message.webm`, { type: 'audio/webm' });
        setFileAttachment(file);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Failed to start recording', err);
      setError('Microphone access denied or unavailable.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      setFileAttachment(null);
    }
  };

  const handleLeaveRoom = async () => {
    if (unsubscribeMessagesRef.current) unsubscribeMessagesRef.current();
    if (unsubscribeParticipantsRef.current)
      unsubscribeParticipantsRef.current();
    if (unsubscribeMetadataRef.current) unsubscribeMetadataRef.current();
    if (heartbeatIntervalRef.current)
      clearInterval(heartbeatIntervalRef.current);
    if (handleOnlineRef.current)
      window.removeEventListener('online', handleOnlineRef.current);
    if (handleOfflineRef.current)
      window.removeEventListener('offline', handleOfflineRef.current);
    setIsReconnecting(false);

    if (step === 'chat' && roomCode && participantId) {
      try {
        await deleteDoc(
          doc(db, 'chatRooms', roomCode, 'participants', participantId)
        );
      } catch (e) {
        console.error('Failed to remove participant', e);
      }
    }

    setStep('setup');
    setMessages([]);
    setParticipants([]);
    setPinnedMessageId(null);
    setEditingMessageId(null);
    setFileAttachment(null);
    setReplyingTo(null);
    
    // Remove room from URL
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
  };

  const copyInviteLink = () => {
    const baseUrl = window.location.origin + window.location.pathname;
    const inviteUrl = `${baseUrl}?room=${roomCode}`;
    navigator.clipboard.writeText(inviteUrl);
    alert('Invite link copied to clipboard!');
  };

  const downloadAttachment = async (attachment: FileAttachment, messageKey: string) => {
    try {
      const decrypted = await decryptData(attachment.data, messageKey);
      const blob = new Blob([decrypted.data], { type: attachment.type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to decrypt attachment', e);
      alert('Failed to decrypt attachment.');
    }
  };

  const now = Date.now();
  const activeParticipants = participants.filter(
    (p) => now - p.lastActive < 45000
  );
  const typingParticipants = activeParticipants.filter(
    (p) => p.isTyping && p.name !== userName
  );
  const pinnedMessage = messages.find((m) => m.id === pinnedMessageId);

  return (
    <div className="max-w-4xl mx-auto">
      <AnimatePresence>
        {screenshotWarning && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-red-500 text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-2 font-medium"
          >
            <AlertTriangle className="w-5 h-5" />
            Screenshot detected!
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={onBack}
        className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 mb-8 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Home
      </button>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 sm:p-10 shadow-sm border border-zinc-200 dark:border-zinc-800 min-h-[600px] flex flex-col">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-semibold flex items-center gap-3">
            <MessageSquare className="w-6 h-6 text-indigo-500" />
            Secret Chat
          </h2>
          {step === 'chat' && (
            <button
              onClick={handleLeaveRoom}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Leave Room
            </button>
          )}
        </div>

        {step === 'setup' ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full space-y-6"
          >
            <div className="text-center mb-4">
              <p className="text-zinc-500 dark:text-zinc-400">
                Join a secure, end-to-end encrypted group chat. Messages are
                never stored permanently and disappear after the set time.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Room ID</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Key className="w-4 h-4 text-zinc-400" />
                  </div>
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value)}
                    placeholder="Enter room ID..."
                    className="w-full pl-10 pr-4 py-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                  />
                </div>
                <button
                  onClick={handleGenerateRoom}
                  className="px-4 py-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 font-medium transition-colors flex items-center gap-2"
                  title="Generate secure room ID"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Your Name
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <User className="w-4 h-4 text-zinc-400" />
                </div>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Enter your display name..."
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Chat Duration (Expiry)
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[1 / 6, 0.5, 1, 3, 5, 10].map((mins) => (
                  <button
                    key={mins}
                    onClick={() => setExpiryMinutes(mins)}
                    className={cn(
                      'py-2 rounded-lg text-xs font-medium border transition-all',
                      expiryMinutes === mins
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'bg-zinc-50 dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-indigo-500'
                    )}
                  >
                    {mins < 1 ? `${mins * 60}s` : `${mins}m`}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-zinc-500 mt-2 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Messages will disappear for everyone after this time.
              </p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 rounded-lg text-sm text-center">
                {error}
              </div>
            )}

            <button
              onClick={handleJoinChat}
              className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium text-lg transition-colors flex items-center justify-center gap-2"
            >
              <MessageSquare className="w-5 h-5" />
              Join Secret Chat
            </button>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex-1 flex flex-col md:flex-row gap-6 h-full relative"
          >
            {isReconnecting && (
              <div className="absolute top-0 left-0 right-0 z-10 flex justify-center">
                <div className="bg-amber-500 text-white text-xs font-medium px-3 py-1.5 rounded-b-lg shadow-sm flex items-center gap-2">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Connection lost. Reconnecting...
                </div>
              </div>
            )}
            {/* Sidebar: Participants */}
            <div className="w-full md:w-48 flex flex-col gap-4">
              <div className="p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Users className="w-3 h-3" />
                  Participants
                </h3>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {participants.map((p, i) => {
                    const isOnline = now - p.lastActive < 45000;
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300"
                      >
                        <div
                          className={cn(
                            'w-2 h-2 rounded-full',
                            isOnline ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-700'
                          )}
                        />
                        {p.name}{' '}
                        {p.name === userName && (
                          <span className="text-[10px] text-zinc-500">(You)</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                  <Clock className="w-3 h-3" />
                  Room Info
                </h3>
                <p className="text-[10px] text-zinc-500 mb-1">Room ID:</p>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100">
                    {roomCode}
                  </p>
                  <button
                    onClick={copyInviteLink}
                    className="text-zinc-400 hover:text-indigo-500 transition-colors"
                    title="Copy Invite Link"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                <p className="text-[10px] text-zinc-500 mb-1">Expiry:</p>
                <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                  {expiryMinutes < 1
                    ? `${expiryMinutes * 60}s`
                    : `${expiryMinutes}m`}
                </p>
              </div>
            </div>

            {/* Main Chat Area */}
            <div className="flex-1 flex flex-col min-h-[400px] relative">
              {pinnedMessage && (
                <div className="absolute top-0 left-0 right-0 z-10 bg-indigo-50 dark:bg-indigo-900/20 border-b border-indigo-100 dark:border-indigo-800/30 p-3 rounded-t-2xl flex items-start gap-3 shadow-sm">
                  <Pin className="w-4 h-4 text-indigo-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-400 mb-0.5">
                      Pinned Message
                    </p>
                    <p className="text-sm text-zinc-700 dark:text-zinc-300 truncate">
                      {pinnedMessage.text}
                    </p>
                  </div>
                  <button
                    onClick={() => handlePinMessage(pinnedMessage.id)}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              <div
                className={cn(
                  'flex-1 overflow-y-auto mb-4 space-y-4 p-2 pb-16 max-h-[500px]',
                  pinnedMessage ? 'pt-20' : ''
                )}
              >
                {messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-zinc-400 text-sm">
                    No messages yet. Start the conversation!
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isReadByOthers =
                      (msg.readBy || []).filter((r) => r !== msg.sender).length > 0;
                    const isDelivered = activeParticipants.length > 1;

                    return (
                      <div
                        key={msg.id}
                        className={cn(
                          'flex flex-col max-w-[85%]',
                          msg.isSelf ? 'ml-auto items-end' : 'mr-auto items-start'
                        )}
                      >
                        <div
                          className={cn(
                            'flex items-center gap-2 mb-1 px-1',
                            msg.isSelf ? 'flex-row-reverse' : 'flex-row'
                          )}
                        >
                          <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
                            {msg.isSelf ? 'You' : msg.sender}
                          </span>
                          <span className="text-[10px] text-zinc-400">
                            {new Date(msg.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div
                          className={cn(
                            'px-4 py-2 rounded-2xl relative group cursor-pointer sm:cursor-default',
                            msg.isSelf
                              ? 'bg-indigo-600 text-white rounded-br-sm'
                              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-sm'
                          )}
                          onClick={() => setActiveMessageId(activeMessageId === msg.id ? null : msg.id)}
                        >
                          {msg.replyTo && (
                            <div className="mb-2 p-2 rounded bg-black/10 dark:bg-white/10 border-l-2 border-indigo-400 text-xs">
                              <span className="font-bold">{msg.replyTo.sender}</span>
                              <p className="truncate opacity-80">{msg.replyTo.text}</p>
                            </div>
                          )}
                          {msg.fileAttachment && (
                            <div
                              className={cn(
                                'mb-2 p-2 rounded-lg flex items-center gap-3 cursor-pointer hover:opacity-90 transition-opacity',
                                msg.isSelf
                                  ? 'bg-indigo-700/50'
                                  : 'bg-zinc-200 dark:bg-zinc-700'
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadAttachment(msg.fileAttachment!, msg.messageKey || roomCode);
                              }}
                            >
                              {msg.fileAttachment.type.startsWith('image/') ? (
                                <ImageIcon className="w-5 h-5" />
                              ) : msg.fileAttachment.type.startsWith('audio/') ? (
                                <Music className="w-5 h-5" />
                              ) : (
                                <File className="w-5 h-5" />
                              )}
                              <span className="text-sm font-medium truncate max-w-[150px]">
                                {msg.fileAttachment.name}
                              </span>
                            </div>
                          )}
                          <p className="whitespace-pre-wrap break-words text-sm">
                            {msg.text}
                          </p>

                          {Object.keys(msg.reactions || {}).length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {Object.entries(msg.reactions!).map(([emoji, usersAny]) => {
                                const users = usersAny as string[];
                                if (users.length === 0) return null;
                                const hasReacted = users.includes(userName);
                                return (
                                  <button
                                    key={emoji}
                                    onClick={() => handleReact(msg.id, emoji)}
                                    className={cn(
                                      "text-[10px] px-1.5 py-0.5 rounded-full border flex items-center gap-1 transition-colors",
                                      hasReacted
                                        ? "bg-indigo-100 border-indigo-300 dark:bg-indigo-900/50 dark:border-indigo-700 text-indigo-800 dark:text-indigo-200"
                                        : "bg-white border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300"
                                    )}
                                  >
                                    <span>{emoji}</span>
                                    {users.length > 1 && <span className="font-medium">{users.length}</span>}
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          <div
                            className={cn(
                              'flex items-center gap-1 mt-1 justify-end',
                              msg.isSelf ? 'text-indigo-200' : 'text-zinc-500'
                            )}
                          >
                            {msg.isEdited && (
                              <span className="text-[9px] italic mr-1">
                                (edited)
                              </span>
                            )}
                            {msg.isSelf && (
                              <span className="text-[10px]">
                                {isReadByOthers ? (
                                  <CheckCheck className="w-3 h-3 text-blue-300" />
                                ) : isDelivered ? (
                                  <CheckCheck className="w-3 h-3" />
                                ) : (
                                  <Check className="w-3 h-3" />
                                )}
                              </span>
                            )}
                          </div>

                          <div className={cn(
                            "absolute top-full mt-1 flex flex-wrap sm:flex-nowrap items-center gap-1 bg-white dark:bg-zinc-800 shadow-lg border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 z-50 transition-all w-max max-w-[85vw] sm:max-w-none",
                            msg.isSelf ? "right-0 origin-top-right" : "left-0 origin-top-left",
                            activeMessageId === msg.id 
                              ? "opacity-100 scale-100 pointer-events-auto" 
                              : "opacity-0 scale-95 pointer-events-none sm:group-hover:opacity-100 sm:group-hover:scale-100 sm:group-hover:pointer-events-auto"
                          )}>
                            {['👍', '❤️', '😂', '😮', '😢'].map(emoji => (
                              <button
                                key={emoji}
                                onClick={(e) => { e.stopPropagation(); handleReact(msg.id, emoji); }}
                                className="hover:scale-125 transition-transform px-1.5 text-base"
                              >
                                {emoji}
                              </button>
                            ))}
                            <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1" />
                            <button
                              onClick={(e) => { e.stopPropagation(); setReplyingTo(msg); setActiveMessageId(null); }}
                              className="text-zinc-500 hover:text-indigo-500 p-1.5"
                              title="Reply"
                            >
                              <Reply className="w-4 h-4" />
                            </button>
                            {msg.isSelf && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleEditMessage(msg); setActiveMessageId(null); }}
                                className="text-zinc-500 hover:text-indigo-500 p-1.5"
                                title="Edit"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); handlePinMessage(msg.id); setActiveMessageId(null); }}
                              className="text-zinc-500 hover:text-indigo-500 p-1.5"
                              title="Pin"
                            >
                              <Pin className="w-4 h-4" />
                            </button>
                            <span className="text-[9px] text-zinc-400 whitespace-nowrap ml-1 pr-1">
                              Expires in{' '}
                              {Math.max(
                                0,
                                Math.floor((msg.expiresAt - Date.now()) / 1000)
                              )}
                              s
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {typingParticipants.length > 0 && (
                <div className="absolute bottom-[72px] left-4 text-xs text-zinc-500 italic">
                  {typingParticipants.map((p) => p.name).join(', ')}{' '}
                  {typingParticipants.length === 1 ? 'is' : 'are'} typing...
                </div>
              )}

              {fileAttachment && !isRecording && (
                <div className="absolute bottom-[72px] left-4 bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 rounded-lg text-xs flex items-center gap-2 shadow-sm border border-zinc-200 dark:border-zinc-700">
                  {fileAttachment.type.startsWith('audio/') ? (
                    <Music className="w-3 h-3 text-zinc-500" />
                  ) : (
                    <Paperclip className="w-3 h-3 text-zinc-500" />
                  )}
                  <span className="truncate max-w-[150px] font-medium">
                    {fileAttachment.name}
                  </span>
                  <button
                    onClick={() => setFileAttachment(null)}
                    className="text-zinc-400 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}

              <form onSubmit={handleSendMessage} className="flex flex-col gap-2">
                {replyingTo && (
                  <div className="bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded-lg text-sm flex items-center justify-between border border-zinc-200 dark:border-zinc-700">
                    <div className="flex flex-col truncate">
                      <span className="text-xs font-bold text-indigo-500">Replying to {replyingTo.sender}</span>
                      <span className="text-zinc-600 dark:text-zinc-300 truncate">{replyingTo.text}</span>
                    </div>
                    <button type="button" onClick={() => setReplyingTo(null)} className="text-zinc-400 hover:text-red-500 ml-4 shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <div className="flex gap-2">
                  {isRecording ? (
                    <div className="flex-1 flex items-center justify-between px-4 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
                      <div className="flex items-center gap-3">
                        <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-red-600 dark:text-red-400 font-mono text-sm">
                          {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={cancelRecording}
                          className="p-2 text-zinc-500 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                        <button
                          type="button"
                          onClick={stopRecording}
                          className="p-2 text-red-600 hover:text-red-700 transition-colors"
                        >
                          <Square className="w-5 h-5 fill-current" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileSelect}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-indigo-500 transition-colors shrink-0"
                        title="Attach File (< 500KB)"
                      >
                        <Paperclip className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        onClick={startRecording}
                        className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-red-500 transition-colors shrink-0"
                        title="Record Voice Message"
                      >
                        <Mic className="w-5 h-5" />
                      </button>
                      <input
                        type="text"
                        value={newMessage}
                        onChange={handleTyping}
                        placeholder={
                          editingMessageId
                            ? 'Edit message...'
                            : 'Type an encrypted message...'
                        }
                        className="flex-1 min-w-0 px-4 py-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      />
                      {editingMessageId && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMessageId(null);
                            setNewMessage('');
                          }}
                          className="p-3 text-zinc-400 hover:text-red-500 shrink-0"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      )}
                    </>
                  )}
                  <button
                    type="submit"
                    disabled={
                      (!newMessage.trim() && !fileAttachment) ||
                      isSending ||
                      isReconnecting ||
                      !navigator.onLine ||
                      isRecording
                    }
                    className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shrink-0"
                  >
                    {isSending ? (
                      <RefreshCw className="w-5 h-5 animate-spin" />
                    ) : (
                      <Send className="w-5 h-5" />
                    )}
                    <span className="hidden sm:inline">
                      {editingMessageId ? 'Save' : 'Send'}
                    </span>
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
