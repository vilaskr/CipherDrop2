import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, MessageSquare, Key, RefreshCw, Send, LogOut, Trash2, Clock, Users, User } from 'lucide-react';
import { encryptData, decryptData, generateSecureKey } from '../lib/crypto';
import { cn } from '../lib/utils';
import { io, Socket } from 'socket.io-client';

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  expiresAt: number;
  isSelf: boolean;
}

interface EncryptedPacket {
  ciphertext: string; // The base64 encrypted blob
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
  
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  // Handle disappearing messages
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setMessages(prev => {
        const filtered = prev.filter(msg => msg.expiresAt > now);
        if (filtered.length !== prev.length) return filtered;
        return prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleGenerateRoom = () => {
    setRoomCode(generateSecureKey().substring(0, 12));
  };

  const handleJoinChat = () => {
    if (!roomCode.trim()) {
      setError('Please enter a room code');
      return;
    }
    if (!userName.trim()) {
      setError('Please enter your name');
      return;
    }
    if (roomCode.length < 8) {
      setError('Room code must be at least 8 characters long');
      return;
    }

    setError('');
    
    // Connect to WebSocket server
    const socket = io();
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-room', { 
        roomId: roomCode, 
        name: userName,
        settings: { expiryMinutes }
      });
      setStep('chat');
    });

    socket.on('user-list', (users: string[]) => {
      setParticipants(users);
    });

    socket.on('chat-history', async (history: EncryptedPacket[]) => {
      const decryptedMessages: ChatMessage[] = [];
      for (const packet of history) {
        try {
          const decrypted = await decryptData(packet.ciphertext, roomCode);
          const data = JSON.parse(new TextDecoder().decode(decrypted.data));
          if (data.expiresAt > Date.now()) {
            decryptedMessages.push({
              ...data,
              isSelf: data.sender === userName
            });
          }
        } catch (err) {
          console.error('Failed to decrypt history message', err);
        }
      }
      setMessages(decryptedMessages);
    });

    socket.on('new-message', async (packet: EncryptedPacket & { id: string, timestamp: number }) => {
      try {
        const decrypted = await decryptData(packet.ciphertext, roomCode);
        const data = JSON.parse(new TextDecoder().decode(decrypted.data));
        
        setMessages(prev => [
          ...prev,
          {
            ...data,
            id: packet.id,
            timestamp: packet.timestamp,
            isSelf: data.sender === userName
          }
        ]);
      } catch (err) {
        console.error('Failed to decrypt new message', err);
      }
    });

    socket.on('chat-cleared', () => {
      setMessages([]);
    });

    socket.on('disconnect', () => {
      setStep('setup');
      setMessages([]);
    });
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !socketRef.current) return;

    setIsSending(true);
    const messageText = newMessage;
    setNewMessage('');

    try {
      const messageData = {
        sender: userName,
        text: messageText,
        timestamp: Date.now(),
        expiresAt: Date.now() + expiryMinutes * 60 * 1000
      };

      const dataToEncrypt = new TextEncoder().encode(JSON.stringify(messageData));
      const ciphertext = await encryptData(dataToEncrypt, roomCode, 'text');

      socketRef.current.emit('send-message', {
        roomId: roomCode,
        encryptedMessage: { ciphertext }
      });
    } catch (err) {
      console.error('Failed to send message', err);
      setError('Failed to encrypt and send message');
      setNewMessage(messageText);
    } finally {
      setIsSending(false);
    }
  };

  const handleLeaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
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
            className="flex-1 flex flex-col md:flex-row gap-6 h-full"
          >
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
                      <div className="flex items-center gap-2 mb-1 px-1">
                        {!msg.isSelf && <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300">{msg.sender}</span>}
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
                  disabled={!newMessage.trim() || isSending}
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
