import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useListOpenaiConversations, 
  useCreateOpenaiConversation, 
  useDeleteOpenaiConversation,
  useListOpenaiMessages,
  getListOpenaiConversationsQueryKey,
  getListOpenaiMessagesQueryKey,
} from "@workspace/api-client-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SYSTEM_PROMPT } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Trash2, Send, Loader2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

type StreamingState = {
  content: string;
  isStreaming: boolean;
};

export default function Home() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<StreamingState>({ content: "", isStreaming: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const { data: conversations, isLoading: isConversationsLoading } = useListOpenaiConversations();
  const createConversation = useCreateOpenaiConversation();
  const deleteConversation = useDeleteOpenaiConversation();
  
  const { data: messages, isLoading: isMessagesLoading } = useListOpenaiMessages(activeId as number, {
    query: { enabled: !!activeId, queryKey: getListOpenaiMessagesQueryKey(activeId as number) }
  });

  // Auto-scroll to bottom when messages or streaming content changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming.content]);

  // Create initial conversation if none exist
  useEffect(() => {
    if (!isConversationsLoading && conversations?.length === 0 && !createConversation.isPending) {
      handleCreateConversation();
    } else if (!isConversationsLoading && conversations?.length && activeId === null) {
      // Set the most recent conversation as active
      setActiveId(conversations[0].id);
    }
  }, [isConversationsLoading, conversations, activeId]);

  const handleCreateConversation = useCallback(() => {
    createConversation.mutate({ data: { title: "Новый разговор" } }, {
      onSuccess: (newConv) => {
        queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        setActiveId(newConv.id);
      }
    });
  }, [createConversation, queryClient]);

  const handleDeleteConversation = useCallback((e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    deleteConversation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOpenaiConversationsQueryKey() });
        if (activeId === id) {
          setActiveId(null);
        }
      }
    });
  }, [deleteConversation, queryClient, activeId]);

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim() || !activeId || streaming.isStreaming) return;

    const userMessage = input.trim();
    setInput("");
    
    // Optimistic update for the user message
    const previousMessages = queryClient.getQueryData(getListOpenaiMessagesQueryKey(activeId)) as any[];
    const tempUserMessage = {
      id: Date.now(),
      conversationId: activeId,
      role: "user",
      content: userMessage,
      createdAt: new Date().toISOString()
    };
    
    queryClient.setQueryData(getListOpenaiMessagesQueryKey(activeId), (old: any) => {
      return old ? [...old, tempUserMessage] : [tempUserMessage];
    });

    setStreaming({ content: "", isStreaming: true });

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/openai/conversations/${activeId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sending system prompt at the beginning of the context is ideal, 
        // but the API expects just the current user message.
        // Usually, the system prompt is managed by the backend or injected. 
        // We will try to inject it as a system message if the API supports it, 
        // otherwise we will just send the user message. 
        // If the backend doesn't handle the system prompt, we prepend it to the first message if this is the first message.
        body: JSON.stringify({ 
          content: messages?.length === 0 
            ? `${SYSTEM_PROMPT}\n\nUser: ${userMessage}` 
            : userMessage 
        })
      });

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let streamedContent = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          
          for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.content) {
                  streamedContent += data.content;
                  setStreaming(prev => ({ ...prev, content: streamedContent }));
                }
              } catch (e) {
                // Ignore parse errors for incomplete chunks
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("Streaming error:", error);
    } finally {
      setStreaming({ content: "", isStreaming: false });
      queryClient.invalidateQueries({ queryKey: getListOpenaiMessagesQueryKey(activeId) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="flex h-[100dvh] w-full bg-background overflow-hidden selection:bg-primary/30">
      {/* SIDEBAR */}
      <aside className="w-80 flex-shrink-0 border-r border-border bg-sidebar flex flex-col hidden md:flex">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <div>
            <h1 className="text-xl font-serif text-primary tracking-tight">СОВЕТНИК</h1>
            <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Private Wealth AI</p>
          </div>
        </div>
        
        <div className="p-4">
          <Button 
            onClick={handleCreateConversation} 
            disabled={createConversation.isPending}
            className="w-full bg-transparent hover:bg-white/5 border border-primary/20 text-primary hover:text-primary justify-start font-medium rounded-none h-11 no-default-hover-elevate transition-colors"
          >
            {createConversation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Новая сессия
          </Button>
        </div>

        <ScrollArea className="flex-1 px-4">
          <div className="space-y-1 pb-4">
            {conversations?.map((conv) => (
              <div
                key={conv.id}
                onClick={() => setActiveId(conv.id)}
                className={cn(
                  "group relative w-full flex items-center gap-3 px-4 py-3 text-sm cursor-pointer transition-all duration-200",
                  activeId === conv.id 
                    ? "bg-primary/10 text-primary border-l-2 border-primary" 
                    : "text-sidebar-foreground hover:bg-white/5 hover:text-primary border-l-2 border-transparent"
                )}
              >
                <div className="flex-1 truncate font-medium">
                  {conv.title || "Разговор"}
                </div>
                <button
                  onClick={(e) => handleDeleteConversation(e, conv.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </ScrollArea>
        
        <div className="p-6 border-t border-border mt-auto">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
            <span className="text-xs text-muted-foreground uppercase tracking-widest">Система активна</span>
          </div>
        </div>
      </aside>

      {/* MAIN CHAT */}
      <main className="flex-1 flex flex-col bg-background relative z-10">
        {activeId ? (
          <>
            <header className="h-16 border-b border-border flex items-center px-6 md:px-8 shrink-0 bg-background/80 backdrop-blur-sm sticky top-0 z-20">
              <div className="flex items-center gap-3 md:hidden mr-4">
                <Button variant="ghost" size="icon" onClick={handleCreateConversation} className="rounded-none text-primary">
                  <Plus className="h-5 w-5" />
                </Button>
              </div>
              <h2 className="font-serif text-lg text-foreground truncate">
                {conversations?.find(c => c.id === activeId)?.title || "Разговор"}
              </h2>
            </header>

            <div 
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-4 py-8 md:px-12 scroll-smooth"
            >
              <div className="max-w-3xl mx-auto space-y-10 pb-8">
                {messages?.length === 0 && !streaming.isStreaming && (
                  <div className="flex flex-col items-center justify-center h-64 text-center space-y-4 opacity-50">
                    <MessageSquare className="h-12 w-12 text-primary" strokeWidth={1} />
                    <p className="font-serif text-xl">Чем я могу помочь вам сегодня?</p>
                  </div>
                )}
                
                {messages?.map((msg, idx) => (
                  <div 
                    key={msg.id || idx} 
                    className={cn(
                      "flex flex-col w-full animate-in fade-in slide-in-from-bottom-2 duration-500",
                      msg.role === "user" ? "items-end" : "items-start"
                    )}
                  >
                    <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2 px-1">
                      {msg.role === "user" ? "Вы" : "Советник"}
                    </div>
                    <div 
                      className={cn(
                        "px-6 py-4 max-w-[90%] text-[15px] leading-relaxed",
                        msg.role === "user" 
                          ? "bg-primary text-primary-foreground" 
                          : "bg-card border border-border prose prose-invert prose-p:leading-relaxed prose-pre:bg-black/50"
                      )}
                    >
                      {msg.role === "user" ? (
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                      ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      )}
                    </div>
                  </div>
                ))}
                
                {streaming.isStreaming && (
                  <div className="flex flex-col w-full items-start animate-in fade-in duration-300">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2 px-1 flex items-center gap-2">
                      Советник <span className="inline-flex h-1 w-1 bg-primary rounded-full animate-ping"></span>
                    </div>
                    <div className="px-6 py-4 max-w-[90%] text-[15px] leading-relaxed bg-card border border-primary/30 prose prose-invert prose-p:leading-relaxed shadow-[0_0_15px_rgba(212,175,55,0.05)]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {streaming.content + "█"}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 md:p-6 bg-background/80 backdrop-blur-md border-t border-border mt-auto">
              <div className="max-w-3xl mx-auto relative">
                <form 
                  onSubmit={handleSendMessage}
                  className="relative flex items-end w-full border border-border bg-card focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20 transition-all shadow-sm"
                >
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Напишите сообщение..."
                    className="flex min-h-[56px] max-h-60 w-full resize-none bg-transparent px-4 py-4 text-[15px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
                    rows={1}
                    disabled={streaming.isStreaming}
                  />
                  <div className="p-2 shrink-0">
                    <Button 
                      type="submit" 
                      size="icon" 
                      disabled={!input.trim() || streaming.isStreaming}
                      className="h-10 w-10 rounded-none bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:bg-muted disabled:text-muted-foreground transition-all"
                    >
                      {streaming.isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 ml-0.5" />}
                    </Button>
                  </div>
                </form>
                <div className="text-center mt-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                    Советник может ошибаться. Проверяйте важную финансовую информацию.
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            {isConversationsLoading ? (
              <Loader2 className="h-8 w-8 text-primary animate-spin" />
            ) : (
              <div className="text-center">
                <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" strokeWidth={1} />
                <h3 className="font-serif text-xl mb-2 text-foreground">Нет активных разговоров</h3>
                <p className="text-muted-foreground text-sm mb-6 max-w-sm">
                  Нажмите на кнопку "Новая сессия", чтобы начать работу с вашим персональным советником.
                </p>
                <Button 
                  onClick={handleCreateConversation} 
                  disabled={createConversation.isPending}
                  className="bg-primary text-primary-foreground rounded-none px-8 font-medium hover:bg-primary/90 transition-colors"
                >
                  {createConversation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                  Начать сессию
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}