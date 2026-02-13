import React, { useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { LogIn, UserPlus, Mail, Lock, Sparkles, CheckCircle2, ShieldCheck } from 'lucide-react';

export default function Login({ forceRecovery = false }: { forceRecovery?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [isPasswordUpdated, setIsPasswordUpdated] = useState(false);
  const [isResetPassword, setIsResetPassword] = useState(false);
  const [resetEmailSent, setResetEmailSent] = useState(false);
  // Inicializa isUpdatingPassword baseado na prop ou na URL imediatamente
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(() => 
    forceRecovery ||
    window.location.hash.includes('type=recovery') || 
    window.location.search.includes('type=recovery')
  );
  const [newPassword, setNewPassword] = useState('');

  // Sincronizar estado se a prop mudar ou se houver evento de recuperação
  React.useEffect(() => {
    let subscription: any;

    if (forceRecovery) {
      setIsUpdatingPassword(true);
    }

    const setupAuthListener = async () => {
      const { data } = supabase.auth.onAuthStateChange(async (event) => {
        if (event === 'PASSWORD_RECOVERY') {
          setIsUpdatingPassword(true);
        }
      });
      subscription = data.subscription;
    };

    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session && !session.user?.email_confirmed_at) {
        setNeedsVerification(true);
        setEmail(session.user.email || '');
      }
    };

    setupAuthListener();
    checkSession();

    return () => {
      if (subscription) subscription.unsubscribe();
    };
  }, [forceRecovery]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (isSignUp) {
        // Validação básica antes de enviar ao Supabase
        if (password.length < 6) {
          throw new Error('A senha deve ter no mínimo 6 caracteres.');
        }

        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password: password,
          options: {
            emailRedirectTo: window.location.origin
          }
        });

        if (signUpError) {
          // Tratamento amigável para erros comuns do Supabase
          if (signUpError.message.includes('rate limit')) {
            throw new Error('Muitas tentativas. Por favor, aguarde alguns minutos antes de tentar novamente.');
          }
          if (signUpError.message.includes('already registered')) {
            throw new Error('Este e-mail já está cadastrado. Tente fazer login.');
          }
          throw signUpError;
        }

        if (signUpData.user) {
          // Normalizar e-mail para evitar duplicatas por case-sensitivity
          const normalizedEmail = email.trim().toLowerCase();

          // Se não houver sessão ou o e-mail não estiver confirmado, precisa de verificação
          if (signUpData.session === null || !signUpData.user.email_confirmed_at) {
            setNeedsVerification(true);
            
            // Verificar se o perfil já existe antes de tentar criar
            const { data: profileExists } = await supabase
              .from('profiles')
              .select('id')
              .eq('email', normalizedEmail)
              .single();

            if (!profileExists) {
              // Criar perfil inicial sem trial (o trial só vem após confirmar e-mail)
              await supabase
                .from('profiles')
                .insert({
                  email: normalizedEmail,
                  subscription_active: false,
                  updated_at: new Date().toISOString()
                });
            }
          } else {
            // Se já veio confirmado (ex: confirmação desativada no Supabase), dá o trial direto
            await handlePostSignup(normalizedEmail);
          }
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

        if (signInError) {
          if (signInError.message.includes('Email not confirmed')) {
            setNeedsVerification(true);
            throw new Error('Por favor, confirme seu e-mail antes de fazer login. Verifique sua caixa de entrada.');
          }
          throw signInError;
        }
      }
    } catch (err: any) {
      setError(err.message || 'Ocorreu um erro na autenticação');
    } finally {
      setLoading(false);
    }
  };

  const handlePostSignup = async (userEmail: string) => {
    try {
      const normalizedEmail = userEmail.trim().toLowerCase();
      
      const { data: existingProfile, error: fetchError } = await supabase
        .from('profiles')
        .select('subscription_active, trial_ends_at')
        .eq('email', normalizedEmail)
        .single();

      // Se houver erro de "não encontrado", não é um bug, apenas criamos o perfil
      if (fetchError && fetchError.code !== 'PGRST116') {
        throw fetchError;
      }

      if (!existingProfile?.subscription_active && !existingProfile?.trial_ends_at) {
        const trialEndsAt = new Date();
        trialEndsAt.setDate(trialEndsAt.getDate() + 3);

        const { error: upsertError } = await supabase
          .from('profiles')
          .upsert({
            email: normalizedEmail,
            subscription_active: false,
            trial_ends_at: trialEndsAt.toISOString(),
            updated_at: new Date().toISOString()
          }, { onConflict: 'email' });
        
        if (upsertError) throw upsertError;
        
        console.log('Trial de 3 dias ativado com sucesso.');
        return true;
      }
      return false;
    } catch (err) {
      console.error('Erro ao processar post-signup:', err);
      return false;
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      
      // 1. Verificar o código OTP
      const { data, error: otpError } = await supabase.auth.verifyOtp({
        email: normalizedEmail,
        token: verificationCode.trim(),
        type: 'signup'
      });
      
      if (otpError) throw otpError;
      
      // 2. Ativar o trial no banco de dados
      await handlePostSignup(normalizedEmail);
      
      setIsSuccess(true);
      
      // 3. Aguardar o sucesso visual
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 4. Se já temos uma sessão após o OTP, redirecionamos direto para a Home
      // O Supabase geralmente faz o login automático após verifyOtp do tipo signup
      if (data.session) {
        window.location.href = window.location.origin;
      } else {
        // Fallback: se não logou automático, vai para o login limpo
        window.location.href = window.location.origin + window.location.pathname;
      }
    } catch (err: any) {
      setError(err.message || 'Código inválido ou expirado. Verifique seu e-mail novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      if (resetError) throw resetError;
      setResetEmailSent(true);
    } catch (err: any) {
      setError(err.message || 'Erro ao enviar e-mail de recuperação.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      setError('A senha deve ter no mínimo 6 caracteres.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword.trim()
      });
      if (updateError) throw updateError;
      
      setIsPasswordUpdated(true);
      
      // Logout imediato para garantir que a sessão antiga não cause "vazamentos"
      await supabase.auth.signOut();
      
      setTimeout(() => {
        setIsUpdatingPassword(false);
        setIsPasswordUpdated(false);
        // Redireciona de forma limpa
        window.location.href = window.location.origin + window.location.pathname;
      }, 3000);
    } catch (err: any) {
      setError(err.message || 'Erro ao atualizar senha.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-900 px-4 py-8">
      {/* Logo/Header Area */}
      <div className="mb-8 text-center">
        <div className="w-32 h-32 mx-auto mb-4 drop-shadow-2xl transition-transform hover:scale-110 duration-300">
          <img 
            src="/assets/logo.png" 
            alt="Bizu App Logo" 
            className="w-full h-full object-contain"
          />
        </div>
        <p className="text-slate-500 dark:text-slate-400 font-bold mt-2 uppercase text-xs tracking-[0.2em]">
          Sua aprovação começa aqui.
        </p>
      </div>

      <div className="max-w-md w-full">
        {isSuccess ? (
          <div className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl border-2 border-b-[6px] border-green-200 dark:border-green-900/30 transition-all text-center animate-in fade-in zoom-in duration-500">
            <div className="w-24 h-24 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-6 animate-bounce">
              <CheckCircle2 className="w-12 h-12 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-3xl font-black text-slate-900 dark:text-white uppercase mb-4">E-mail Verificado!</h2>
            <p className="text-slate-600 dark:text-slate-400 font-bold text-lg mb-6 leading-relaxed">
              Parabéns! Sua conta foi criada e você tem <span className="text-green-600 dark:text-green-400">3 dias de acesso liberado</span> para testar tudo. 🚀
            </p>
            <div className="flex items-center justify-center gap-2 text-slate-400 font-black text-xs uppercase tracking-widest">
              <div className="w-4 h-4 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></div>
              Entrando no aplicativo...
            </div>
          </div>
        ) : isPasswordUpdated ? (
          <div className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl border-2 border-b-[6px] border-green-200 dark:border-green-900/30 transition-all text-center animate-in fade-in zoom-in duration-500">
            <div className="w-24 h-24 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-6 animate-bounce">
              <CheckCircle2 className="w-12 h-12 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-3xl font-black text-slate-900 dark:text-white uppercase mb-4">Senha Alterada!</h2>
            <p className="text-slate-600 dark:text-slate-400 font-bold text-lg mb-6 leading-relaxed">
              Sua senha foi atualizada com <span className="text-green-600 dark:text-green-400">sucesso</span>. Use sua nova senha para entrar.
            </p>
            <div className="flex items-center justify-center gap-2 text-slate-400 font-black text-xs uppercase tracking-widest">
              <div className="w-4 h-4 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></div>
              Redirecionando para o login...
            </div>
          </div>
        ) : isUpdatingPassword ? (
          <div className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl border-2 border-b-[6px] border-slate-200 dark:border-slate-700 transition-all space-y-6">
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <ShieldCheck className="w-8 h-8 text-blue-600 dark:text-blue-400" />
              </div>
              <h2 className="text-2xl font-black text-slate-900 dark:text-white uppercase">Nova Senha</h2>
              <p className="text-slate-600 dark:text-slate-400 mt-2 font-medium">
                Escolha sua nova senha de acesso.
              </p>
            </div>

            <form onSubmit={handleUpdatePassword} className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-black uppercase text-slate-500 dark:text-slate-400 ml-1">Nova Senha</label>
                <div className="relative group">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-blue-600 transition-colors" />
                  <input
                    type="password"
                    required
                    placeholder="No mínimo 6 caracteres"
                    className="w-full pl-12 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-slate-100 dark:border-slate-700 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-600 outline-none transition-all font-medium"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm font-bold bg-red-50 dark:bg-red-900/20 p-4 rounded-2xl border border-red-100 dark:border-red-800">
                  <ShieldCheck className="w-5 h-5 shrink-0" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-4 rounded-2xl border-b-4 border-blue-800 transition-all active:border-b-0 active:translate-y-[2px] disabled:opacity-50 flex items-center justify-center gap-2 text-lg uppercase"
              >
                {loading ? <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin" /> : "Salvar Nova Senha"}
              </button>
            </form>
          </div>
        ) : isResetPassword ? (
          <div className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl border-2 border-b-[6px] border-slate-200 dark:border-slate-700 transition-all space-y-6">
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Lock className="w-8 h-8 text-blue-600 dark:text-blue-400" />
              </div>
              <h2 className="text-2xl font-black text-slate-900 dark:text-white uppercase">Recuperar Senha</h2>
              <p className="text-slate-600 dark:text-slate-400 mt-2 font-medium">
                {resetEmailSent 
                  ? "Enviamos um link de recuperação para seu e-mail." 
                  : "Digite seu e-mail para receber um link de redefinição."}
              </p>
            </div>

            {resetEmailSent ? (
              <div className="bg-green-50 dark:bg-green-900/20 p-6 rounded-2xl border border-green-100 dark:border-green-800 text-center space-y-4">
                <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-400 mx-auto" />
                <p className="text-green-800 dark:text-green-300 font-bold">E-mail enviado com sucesso!</p>
                <button
                  onClick={() => {
                    setIsResetPassword(false);
                    setResetEmailSent(false);
                  }}
                  className="text-blue-600 font-black uppercase text-sm hover:underline"
                >
                  Voltar para o login
                </button>
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase text-slate-500 dark:text-slate-400 ml-1">Seu E-mail</label>
                  <div className="relative group">
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-blue-600 transition-colors" />
                    <input
                      type="email"
                      required
                      placeholder="email@exemplo.com"
                      className="w-full pl-12 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-slate-100 dark:border-slate-700 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-600 outline-none transition-all font-medium"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm font-bold bg-red-50 dark:bg-red-900/20 p-4 rounded-2xl border border-red-100 dark:border-red-800">
                    <ShieldCheck className="w-5 h-5 shrink-0" />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-4 rounded-2xl border-b-4 border-blue-800 transition-all active:border-b-0 active:translate-y-[2px] disabled:opacity-50 flex items-center justify-center gap-2 text-lg uppercase"
                >
                  {loading ? <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin" /> : "Enviar Link"}
                </button>

                <button
                  type="button"
                  onClick={() => setIsResetPassword(false)}
                  className="w-full text-slate-500 dark:text-slate-400 font-black text-sm uppercase hover:text-blue-600 transition-colors"
                >
                  Cancelar
                </button>
              </form>
            )}
          </div>
        ) : needsVerification ? (
          <div className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl shadow-slate-200/50 dark:shadow-none border-2 border-b-[6px] border-slate-200 dark:border-slate-700 transition-all space-y-6">
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Mail className="w-8 h-8 text-blue-600 dark:text-blue-400" />
              </div>
              <h2 className="text-2xl font-black text-slate-900 dark:text-white uppercase">Verifique seu E-mail</h2>
              <p className="text-slate-600 dark:text-slate-400 mt-2 font-medium">
                Enviamos um código de verificação para <strong>{email}</strong>.
              </p>
            </div>

            <form onSubmit={handleVerifyOTP} className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-black uppercase text-slate-500 dark:text-slate-400 ml-1">Código de Verificação</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <CheckCircle2 className="h-5 w-5 text-slate-400 group-focus-within:text-blue-600 transition-colors" />
                  </div>
                  <input
                    type="text"
                    required
                    placeholder="Digite o código enviado"
                    className="w-full pl-11 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border-2 border-slate-100 dark:border-slate-700 rounded-2xl focus:ring-4 focus:ring-blue-500/10 focus:border-blue-600 outline-none transition-all font-bold text-lg tracking-[0.1em] text-center"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm font-bold bg-red-50 dark:bg-red-900/20 p-4 rounded-2xl border border-red-100 dark:border-red-800">
                  <ShieldCheck className="w-5 h-5 shrink-0" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-4 rounded-2xl border-b-4 border-blue-800 transition-all active:border-b-0 active:translate-y-[2px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-lg uppercase tracking-wider"
              >
                {loading ? (
                  <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>Verificar Código</>
                )}
              </button>
            </form>

            <button
              onClick={() => setNeedsVerification(false)}
              className="w-full text-slate-500 dark:text-slate-400 font-black text-sm uppercase hover:text-blue-600 transition-colors"
            >
              Voltar para o Login
            </button>
          </div>
        ) : (
          <>
            {/* Info Card - 3 Days Trial */}
            {isSignUp && (
              <div className="mb-6 bg-gradient-to-br from-blue-600 to-indigo-700 p-5 rounded-3xl shadow-xl shadow-blue-500/20 text-white relative overflow-hidden">
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="w-5 h-5 text-blue-200" />
                    <span className="font-black text-sm uppercase tracking-wider">Oferta de Boas-Vindas</span>
                  </div>
                  <h3 className="text-xl font-black mb-1 text-white">TESTE POR 3 DIAS! 🚀</h3>
                  <p className="text-blue-50 text-sm font-bold leading-relaxed">
                    Crie sua conta agora e teste a plataforma por 3 dias grátis.
                  </p>
                </div>
                {/* Decorative circles */}
                <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-white/10 rounded-full blur-2xl"></div>
              </div>
            )}

            {/* Main Form Card */}
            <div className="bg-white dark:bg-slate-800 p-8 rounded-[2.5rem] shadow-2xl shadow-slate-200/50 dark:shadow-none border-2 border-b-[6px] border-slate-200 dark:border-slate-700 transition-all">
              <div className="mb-8 flex justify-between items-center">
                <h2 className="text-2xl font-black text-slate-800 dark:text-white uppercase tracking-tight">
                  {isSignUp ? 'Criar Conta' : 'Entrar'}
                </h2>
                {isSignUp ? <UserPlus className="text-blue-600 w-6 h-6" /> : <LogIn className="text-blue-600 w-6 h-6" />}
              </div>

              <form className="space-y-5" onSubmit={handleAuth}>
                <div className="space-y-4">
                  <div className="relative group">
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-blue-600 transition-colors" />
                    <input
                      type="email"
                      required
                      className="w-full pl-12 pr-4 py-4 bg-slate-50 dark:bg-slate-700/50 border-2 border-slate-100 dark:border-slate-700 rounded-2xl text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                      placeholder="Seu melhor e-mail"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>

                  <div className="relative group">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-blue-600 transition-colors" />
                    <input
                      type="password"
                      required
                      className="w-full pl-12 pr-4 py-4 bg-slate-50 dark:bg-slate-700/50 border-2 border-slate-100 dark:border-slate-700 rounded-2xl text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-500/10 transition-all font-medium"
                      placeholder="Sua senha secreta"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  
                  {!isSignUp && (
                    <div className="text-right">
                      <button
                        type="button"
                        onClick={() => setIsResetPassword(true)}
                        className="text-xs font-black uppercase text-blue-600 hover:text-blue-500 transition-colors"
                      >
                        Esqueceu a senha?
                      </button>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm font-bold bg-red-50 dark:bg-red-900/20 p-4 rounded-2xl border border-red-100 dark:border-red-800">
                    <ShieldCheck className="w-5 h-5 shrink-0" />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white px-6 py-5 rounded-2xl border-b-4 border-blue-800 font-black text-lg transition-all active:border-b-0 active:translate-y-[2px] disabled:opacity-50 flex items-center justify-center gap-3 shadow-lg shadow-blue-500/30"
                >
                  {loading ? (
                    <div className="w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
                  ) : (
                    <>
                      {isSignUp ? 'COMEÇAR AGORA' : 'ENTRAR NO APP'}
                      <Sparkles className="w-5 h-5" />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-8 pt-6 border-t-2 border-slate-100 dark:border-slate-700 text-center">
                <p className="text-slate-500 dark:text-slate-400 font-bold text-sm">
                  {isSignUp ? 'Já faz parte do time?' : 'Ainda não tem acesso?'}
                  <button
                    onClick={() => setIsSignUp(!isSignUp)}
                    className="ml-2 text-blue-600 hover:text-blue-500 underline underline-offset-4 decoration-2"
                  >
                    {isSignUp ? 'Fazer Login' : 'Criar Conta Grátis'}
                  </button>
                </p>
              </div>
            </div>
          </>
        )}

        {/* Footer info */}
        <p className="mt-8 text-center text-slate-400 dark:text-slate-500 text-xs font-bold uppercase tracking-widest px-8 leading-relaxed">
          Plataforma de estudos inteligente para Concursos, ENEM e Vestibulares.
        </p>
      </div>
    </div>
  );
}
