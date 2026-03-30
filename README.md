# Gestão de Pallets — Painel Web

Painel web colaborativo para coordenação logística de 3 modelos de pallets:
- **PBR** — logística reversa mensal, custos de frete por região
- **CHEP** — controle de estoque (entrada/saída)
- **Fumigado** — controle de estoque (entrada/saída)

## Iniciar o servidor

```bash
npm install
npm start
```

O painel fica acessível em `http://localhost:3000`.

## Acesso

| Perfil    | Pode ver dados? | Pode lançar/editar? |
|-----------|:---------------:|:-------------------:|
| Visitante | Sim             | Não                 |
| Admin     | Sim             | Sim                 |

**Credenciais padrão do admin:**
- Usuário: `admin`
- Senha: `pallets2026`

Para alterar, defina variáveis de ambiente antes de iniciar:

```bash
ADMIN_USER=meuusuario ADMIN_PASS=minhasenha npm start
```

## Compartilhar o link

Ao rodar o servidor em uma máquina acessível na rede (ou em serviço como Railway, Render, etc.), basta enviar o link `http://<seu-ip>:3000` para a equipe.

Visitantes abrem o link e enxergam todos os dados e gráficos.
Somente quem faz login como admin consegue lançar/excluir dados e alterar custos de frete.

## Estrutura

```
server.js        → Servidor Express + API + autenticação
data.json        → Dados persistidos (criado automaticamente)
public/
  index.html     → Interface do painel
  styles.css     → Estilos
  app.js         → Lógica do frontend (chamadas à API)
```
