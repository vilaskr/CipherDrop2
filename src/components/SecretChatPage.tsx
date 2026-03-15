import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, MessageSquare, Key, RefreshCw, Send, LogOut, Trash2, Clock, Users, User } from 'lucide-react';
import { encryptData, decryptData, generateSecureKey } from '../lib/crypto';
import { cn } from '../lib/utils';
import { db } from '../firebase';
import { collection, addDoc, query, orderBy, onSnapshot, deleteDoc, doc, setDoc, Timestamp } from 'firebase/firestore';

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  expiresAt: number;
  isSelf: boolean;
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
  const [participants, setParticipants] = useState<string[]>([]);
  const [isReconnecting, setIsReconnecting] = useState(false);
  
  const [participantId] = useState(() => Math.random().toString(36).substring(2, 15));
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const unsubscribeMessagesRef = useRef<() => void>();
  const unsubscribeParticipantsRef = useRef<() => void>();
  const heartbeatIntervalRef = useRef<NodeJS.Timeout>();
  const handleOnlineRef = useRef<() => void>();
  const handleOfflineRef = useRef<() => void>();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      handleLeaveRoom();
    };
  }, []);

  // Handle disappearing messages
  useEffect(() => {
    if (step !== 'chat') return;
    const interval = setInterval(() => {
      const now = Date.now();
      setMessages(prev => {
        const filtered = prev.filter(msg => msg.expiresAt > now);
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
      const participantRef = doc(db, 'chatRooms', trimmedRoomCode, 'participants', participantId);
      await setDoc(participantRef, {
        name: trimmedUserName,
        lastActive: Date.now()
      });

      // Start heartbeat
      heartbeatIntervalRef.current = setInterval(async () => {
        if (!navigator.onLine) return;
        try {
          await setDoc(participantRef, {
            name: trimmedUserName,
            lastActive: Date.now()
          }, { merge: true });
        } catch (e) {
          console.error('Heartbeat failed', e);
        }
      }, 15000);

      const handleOnline = () => {
        setIsReconnecting(false);
        setDoc(participantRef, {
          name: trimmedUserName,
          lastActive: Date.now()
        }, { merge: true }).catch(console.error);
      };

      const handleOffline = () => {
        setIsReconnecting(true);
      };

      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      handleOnlineRef.current = handleOnline;
      handleOfflineRef.current = handleOffline;

      // Listen for participants
      const participantsQuery = query(collection(db, 'chatRooms', trimmedRoomCode, 'participants'));
      unsubscribeParticipantsRef.current = onSnapshot(participantsQuery, (snapshot) => {
        const now = Date.now();
        const activeUsers: string[] = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          // Consider inactive if no heartbeat for 45 seconds
          if (now - data.lastActive < 45000) {
            activeUsers.push(data.name);
          }
        });
        setParticipants(Array.from(new Set(activeUsers)));
      }, (err) => {
        console.error('Participants listener error:', err);
      });

      // Listen for messages
      const messagesQuery = query(
        collection(db, 'chatRooms', trimmedRoomCode, 'messages'),
        orderBy('timestamp', 'asc')
      );
      
      unsubscribeMessagesRef.current = onSnapshot(messagesQuery, async (snapshot) => {
        const newMessages: ChatMessage[] = [];
        const now = Date.now();
        
        for (const change of snapshot.docChanges()) {
          if (change.type === 'added') {
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
                const decrypted = await decryptData(data.ciphertext, trimmedRoomCode);
                const msgData = JSON.parse(new TextDecoder().decode(decrypted.data));
                
                newMessages.push({
                  ...msgData,
                  id: change.doc.id,
                  timestamp: data.timestamp,
                  expiresAt: expiresAtMs,
                  isSelf: msgData.sender === trimmedUserName
                });
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
        }
        
        if (newMessages.length > 0) {
          setMessages(prev => {
            const combined = [...prev, ...newMessages];
            const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());
            return unique.sort((a, b) => a.timestamp - b.timestamp);
          });
        }
      }, (err) => {
        console.error('Messages listener error:', err);
        setError('Unable to join room. Please check the room ID or connection.');
        handleLeaveRoom();
      });

      setStep('chat');
    } catch (err) {
      console.error('Failed to join room', err);
      setError('Unable to join room. Please check the room ID or connection.');
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || isReconnecting || !navigator.onLine) return;

    setIsSending(true);
    const messageText = newMessage;
    setNewMessage('');

    try {
      const timestamp = Date.now();
      const expiresAtMs = timestamp + expiryMinutes * 60 * 1000;
      const expiresAt = Timestamp.fromMillis(expiresAtMs);
      
      const messageData = {
        sender: userName,
        text: messageText
      };

      const dataToEncrypt = new TextEncoder().encode(JSON.stringify(messageData));
      const ciphertext = await encryptData(dataToEncrypt, roomCode, 'text');

      await addDoc(collection(db, 'chatRooms', roomCode, 'messages'), {
        ciphertext,
        sender: userName,
        timestamp,
        expiresAt
      });
    } catch (err) {
      console.error('Failed to send message', err);
      setError('Failed to encrypt and send message');
      setNewMessage(messageText);
    } finally {
      setIsSending(false);
    }
  };

  const handleLeaveRoom = async () => {
    if (unsubscribeMessagesRef.current) unsubscribeMessagesRef.current();
    if (unsubscribeParticipantsRef.current) unsubscribeParticipantsRef.current();
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    if (handleOnlineRef.current) window.removeEventListener('online', handleOnlineRef.current);
    if (handleOfflineRef.current) window.removeEventListener('offline', handleOfflineRef.current);
    setIsReconnecting(false);
    
    if (step === 'chat' && roomCode && participantId) {
      try {
        await deleteDoc(doc(db, 'chatRooms', roomCode, 'participants', participantId));
      } catch (e) {
        console.error('Failed to remove participant', e);
      }
    }
    
    setStep('setup');
    setMessages([]);
    setParticipants([]);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <button onClick={onBack} className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 mb-8 transition-colors">
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
                Join a secure, end-to-end encrypted group chat. Messages are never stored permanently and disappear after the set time.
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
              <label className="block text-sm font-medium mb-2">Your Name</label>
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
              <label className="block text-sm font-medium mb-2">Chat Duration (Expiry)</label>
              <div className="grid grid-cols-3 gap-2">
                {[1/6, 0.5, 1, 3, 5, 10].map((mins) => (
                  <button
                    key={mins}
                    onClick={() => setExpiryMinutes(mins)}
                    className={cn(
                      "py-2 rounded-lg text-xs font-medium border transition-all",
                      expiryMinutes === mins
                        ? "bg-indigo-600 border-indigo-600 text-white"
                        : "bg-zinc-50 dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-indigo-500"
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
                  {participants.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      {p} {p === userName && <span className="text-[10px] text-zinc-500">(You)</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 bg-zinc-50 dark:bg-zinc-950 rounded-2xl border border-zinc-200 dark:border-zinc-800">
                <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                  <Clock className="w-3 h-3" />
                  Room Info
                </h3>
                <p className="text-[10px] text-zinc-500 mb-1">Room ID:</p>
                <p className="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100 mb-3">{roomCode}</p>
                <p className="text-[10px] text-zinc-500 mb-1">Expiry:</p>
                <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                  {expiryMinutes < 1 ? `${expiryMinutes * 60}s` : `${expiryMinutes}m`}
                </p>
              </div>
            </div>

            {/* Main Chat Area */}
            <div className="flex-1 flex flex-col min-h-[400px]">
              <div className="flex-1 overflow-y-auto mb-4 space-y-4 p-2 max-h-[500px]">
                {messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-zinc-400 text-sm">
                    No messages yet. Start the conversation!
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={cn(
                        "flex flex-col max-w-[85%]",
                        msg.isSelf ? "ml-auto items-end" : "mr-auto items-start"
                      )}
                    >
                      <div className={cn("flex items-center gap-2 mb-1 px-1", msg.isSelf ? "flex-row-reverse" : "flex-row")}>
                        <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
                          {msg.isSelf ? 'You' : msg.sender}
                        </span>
                        <span className="text-[10px] text-zinc-400">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div
                        className={cn(
                          "px-4 py-2 rounded-2xl relative group",
                          msg.isSelf
                            ? "bg-indigo-600 text-white rounded-br-sm"
                            : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-sm"
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words text-sm">{msg.text}</p>
                        
                        <div className="absolute -bottom-5 right-0 opacity-0 group-hover:opacity-100 transition-opacity">
                           <span className="text-[8px] text-zinc-500">
                             Expires in {Math.max(0, Math.floor((msg.expiresAt - Date.now()) / 1000))}s
                           </span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              <form onSubmit={handleSendMessage} className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type an encrypted message..."
                  className="flex-1 px-4 py-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
                <button
                  type="submit"
                  disabled={!newMessage.trim() || isSending || isReconnecting || !navigator.onLine}
                  className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isSending ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                  <span className="hidden sm:inline">Send</span>
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
