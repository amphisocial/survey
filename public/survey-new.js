(async()=>{
  await Athena.requireAuth();

  Athena.appShell('survey-new.html',`
    <div class="page-head">
      <div>
        <h1>Create survey</h1>
        <p class="muted">Create a live audience poll or a classic all-questions-at-once survey.</p>
      </div>
    </div>

    <div class="grid two">
      <section class="panel">
        <span class="section-kicker">Survey type</span>
        <h2>Choose experience</h2>
        <div class="form-grid">
          <label>Survey mode
            <select id="surveyMode">
              <option value="live">Live survey - one active question at a time</option>
              <option value="classic">Classic survey - all questions at once</option>
            </select>
          </label>
          <label id="identityWrap" style="display:none">Respondent identity
            <select id="identityMode">
              <option value="anonymous_or_identified">Let respondent choose anonymous or identified</option>
              <option value="anonymous_only">Anonymous only</option>
              <option value="identified_required">Require name/email</option>
              <option value="invite_required">Invite/login required</option>
            </select>
          </label>
        </div>

        <span class="section-kicker">AI survey agent</span>
        <h2>Describe what you need</h2>
        <div class="form-grid">
          <label>Topic<input id="topic" placeholder="Team blockers, product demo feedback, event poll..."></label>
          <label>Audience<input id="audience" placeholder="Team members, customers, parents, attendees..."></label>
          <label>Goal<input id="goal" placeholder="Decide priority, collect feedback, brainstorm..."></label>
          <label>Description<textarea id="description" rows="7" placeholder="Tell Athena what you want. Vague is okay — the agent will infer a good first draft."></textarea></label>
          <div class="row"><button class="btn soft" id="voiceBtn">🎙️ Voice</button><button class="btn primary" id="aiBtn">Generate with AI</button></div>
          <div class="error" id="err"></div>
        </div>
      </section>

      <section class="panel">
        <span class="section-kicker">Draft</span>
        <div class="form-grid">
          <label>Survey title<input id="title"></label>
          <label>Description<textarea id="surveyDesc" rows="3"></textarea></label>
          <div id="questions" class="list"></div>
          <button class="btn soft" id="addQuestion">Add manual question</button>
          <button class="btn primary large" id="save">Save survey</button>
        </div>
      </section>
    </div>
  `);

  let draft={title:'',description:'',questions:[]};

  function render(){
    Athena.$('#title').value=draft.title||'';
    Athena.$('#surveyDesc').value=draft.description||'';
    Athena.$('#questions').innerHTML=draft.questions.map((q,i)=>`
      <div class="card question-card" data-i="${i}">
        <label>Question<input class="qtext" value="${Athena.escapeHtml(q.question||'')}"></label>
        <label>Type<select class="qtype">
          <option value="single_choice" ${q.type==='single_choice'?'selected':''}>Single choice</option>
          <option value="multi_select" ${q.type==='multi_select'?'selected':''}>Multi-select</option>
          <option value="tag_cloud" ${q.type==='tag_cloud'?'selected':''}>Tag cloud</option>
        </select></label>
        <label>Options <span class="muted">one per line; leave blank for tag cloud</span><textarea class="qopts" rows="4">${Athena.escapeHtml((q.options||[]).join('\n'))}</textarea></label>
        <button class="btn danger remove" type="button">Remove</button>
      </div>`).join('');

    Athena.$all('.card[data-i]').forEach(card=>{
      const i=Number(card.dataset.i);
      card.querySelector('.qtext').oninput=e=>draft.questions[i].question=e.target.value;
      card.querySelector('.qtype').onchange=e=>draft.questions[i].type=e.target.value;
      card.querySelector('.qopts').oninput=e=>draft.questions[i].options=e.target.value.split('\n').map(x=>x.trim()).filter(Boolean);
      card.querySelector('.remove').onclick=()=>{draft.questions.splice(i,1);render();};
    });
  }

  Athena.$('#surveyMode').onchange = () => {
    Athena.$('#identityWrap').style.display = Athena.$('#surveyMode').value === 'classic' ? 'block' : 'none';
  };

  Athena.$('#aiBtn').onclick=async()=>{
    try{
      Athena.$('#err').textContent='';
      Athena.$('#aiBtn').disabled=true;
      Athena.$('#aiBtn').textContent='Thinking...';
      const data=await Athena.api('/api/ai/survey-draft',{method:'POST',body:JSON.stringify({topic:Athena.$('#topic').value,audience:Athena.$('#audience').value,goal:Athena.$('#goal').value,description:Athena.$('#description').value})});
      draft=data.draft;
      render();
      Athena.toast('AI draft created.');
    }catch(e){
      Athena.$('#err').textContent=e.message;
    }finally{
      Athena.$('#aiBtn').disabled=false;
      Athena.$('#aiBtn').textContent='Generate with AI';
    }
  };

  Athena.$('#addQuestion').onclick=()=>{draft.questions.push({type:'single_choice',question:'',options:['Yes','No']});render();};

  Athena.$('#save').onclick=async()=>{
    try{
      draft.title=Athena.$('#title').value;
      draft.description=Athena.$('#surveyDesc').value;
      if(!draft.title) throw new Error('Add a title.');
      if(!draft.questions.length) throw new Error('Add at least one question.');

      const surveyMode = Athena.$('#surveyMode').value;
      const identityMode = Athena.$('#identityMode').value;

      const data=await Athena.api('/api/surveys',{
        method:'POST',
        body:JSON.stringify({
          title:draft.title,
          description:draft.description,
          questions:draft.questions,
          createdByAi:true,
          aiPrompt:Athena.$('#description').value
        })
      });

      if (surveyMode === 'classic') {
        await Athena.api(`/api/surveys/${data.survey.id}/classic-settings`, {
          method: 'PATCH',
          body: JSON.stringify({ surveyMode, respondentIdentityMode: identityMode })
        });
      }

      location.href=`/survey-detail.html?id=${data.survey.id}`;
    }catch(e){
      Athena.$('#err').textContent=e.message;
    }
  };

  Athena.$('#voiceBtn').onclick=()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){Athena.toast('Voice recognition is not supported in this browser.');return;}
    const rec=new SR();
    rec.lang='en-US';
    rec.interimResults=false;
    rec.onresult=e=>{Athena.$('#description').value+=(Athena.$('#description').value?'\n':'')+e.results[0][0].transcript;};
    rec.start();
    Athena.toast('Listening...');
  };

  render();
})();
