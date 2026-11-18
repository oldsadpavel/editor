package com.oldsadpavel.mpi.remote;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(ClipPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
